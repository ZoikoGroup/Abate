-- backend/db/migrations/0050_retention_jurisdiction.sql
-- Phase 5 (Playbook package B5): Jurisdiction Packs, Retention Schedules, Legal Hold, Tombstone Deletion
-- Source: adr/decisions-register.md rows "Initial Jurisdiction Packs" and "Retention Schedules".
-- Rule: no universal retention duration is invented by development. Durations come from tenant
-- configuration, bounded by the jurisdiction pack in effect. No configuration => nothing is deleted.

-- 1. Jurisdiction pack catalog: platform-authored, effective-dated, versioned. NOT tenant data.
--    Content is supplied by the Legal & Policy Lead; abate_app may only read it.
CREATE TABLE IF NOT EXISTS jurisdiction_pack (
  pack_id text NOT NULL,
  version int NOT NULL CHECK (version > 0),
  jurisdiction text NOT NULL,
  sector text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz, -- [effective_from, effective_to) interval; NULL = open-ended
  status text NOT NULL CHECK (status IN ('APPROVED', 'RETIRED')),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

REVOKE INSERT, UPDATE, DELETE ON jurisdiction_pack FROM abate_app;
GRANT SELECT ON jurisdiction_pack TO abate_app;

-- 2. Retention class: tenant-configured duration per data category (append-only versions)
CREATE TABLE IF NOT EXISTS retention_class (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  data_category text NOT NULL CHECK (data_category IN ('WORK_FACT')),
  retention_days int NOT NULL CHECK (retention_days > 0),
  basis text NOT NULL, -- tenant's stated basis / citation for the duration
  version int NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  pack_id text NOT NULL,
  pack_version int NOT NULL, -- jurisdiction pack the duration was validated against
  set_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, data_category, version),
  FOREIGN KEY (pack_id, pack_version) REFERENCES jurisdiction_pack(pack_id, version)
);

-- 3. Legal hold: overrides retention while active (released_at IS NULL)
CREATE TABLE IF NOT EXISTS legal_hold (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  data_category text NOT NULL CHECK (data_category IN ('WORK_FACT')),
  scope_connection_id uuid, -- NULL = whole category
  matter_ref text NOT NULL,
  reason text NOT NULL,
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  release_reason text,
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);

-- 4. Retention run receipt: counts only, never record content
CREATE TABLE IF NOT EXISTS retention_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  data_category text NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETED', 'NO_POLICY', 'BLOCKED')), -- BLOCKED: policy no longer valid under pack in effect
  blocked_reason text,
  retention_class_id uuid,
  retention_class_version int,
  cutoff timestamptz,
  eligible int NOT NULL,
  held int NOT NULL,
  purged int NOT NULL,
  verified int NOT NULL,
  run_by uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Deletion tombstone: proof a record existed and was deleted, without keeping its content.
--    record_digest = sha256 of the deleted row; record_key_digest = sha256 of its source identity,
--    used only to refuse re-ingestion of a purged record. No pseudonym, no source record id.
CREATE TABLE IF NOT EXISTS deletion_tombstone (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL,
  data_category text NOT NULL,
  record_ref uuid NOT NULL,
  record_digest text NOT NULL,
  record_key_digest text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE (tenant_id, record_ref)
);

CREATE INDEX IF NOT EXISTS idx_retention_class_tenant_category ON retention_class(tenant_id, data_category, status);
CREATE INDEX IF NOT EXISTS idx_legal_hold_tenant_active ON legal_hold(tenant_id, data_category) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tombstone_key_digest ON deletion_tombstone(tenant_id, record_key_digest);

-- Forced Row-Level Security on all tenant-owned Phase 5 tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_class', 'legal_hold', 'retention_run', 'deletion_tombstone'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = t) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
           WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END IF;
  END LOOP;
END $$;

-- Append-only: retention runs and tombstones are never rewritten; only verification may be stamped.
REVOKE UPDATE, DELETE ON retention_run FROM abate_app;
REVOKE UPDATE, DELETE ON deletion_tombstone FROM abate_app;
GRANT UPDATE (verified_at) ON deletion_tombstone TO abate_app;
REVOKE DELETE ON retention_class, legal_hold FROM abate_app;

-- 6. Work facts stay append-only except for retention purge. A DELETE is refused unless a tombstone
--    for the row already exists in the tenant AND no active legal hold covers it.
GRANT DELETE ON work_fact_revision TO abate_app;

CREATE OR REPLACE FUNCTION enforce_work_fact_purge() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM deletion_tombstone
    WHERE tenant_id = OLD.tenant_id AND record_ref = OLD.id
  ) THEN
    RAISE EXCEPTION 'work_fact_revision % cannot be deleted without a deletion tombstone', OLD.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM legal_hold
    WHERE tenant_id = OLD.tenant_id
      AND data_category = 'WORK_FACT'
      AND released_at IS NULL
      AND (scope_connection_id IS NULL OR scope_connection_id = OLD.connection_id)
  ) THEN
    RAISE EXCEPTION 'work_fact_revision % is under legal hold', OLD.id;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_fact_purge_guard ON work_fact_revision;
CREATE TRIGGER work_fact_purge_guard
  BEFORE DELETE ON work_fact_revision
  FOR EACH ROW EXECUTE FUNCTION enforce_work_fact_purge();
