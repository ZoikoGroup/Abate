-- 0081_phase2_identity_map.sql
-- Phase 2 Ingestion: Isolated Identity Map Table & Restricted Grants
-- Architecture Ref: ZAB-ENG-001 v1.0 / Package B2 (Domains S02 & S03)
-- Guarantees: Raw employee keys are kept isolated from the work fact ledger.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abate_identity') THEN
    CREATE ROLE abate_identity WITH LOGIN PASSWORD 'identity_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS identity_map (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  source_subject_ref TEXT NOT NULL,
  subject_pseudonym TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_identity_map_source UNIQUE (tenant_id, connection_id, source_subject_ref),
  CONSTRAINT uq_identity_map_pseudo UNIQUE (tenant_id, connection_id, subject_pseudonym)
);

CREATE INDEX IF NOT EXISTS idx_identity_map_lookup
  ON identity_map (tenant_id, connection_id, subject_pseudonym);

ALTER TABLE identity_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_map FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS identity_map_tenant_isolation ON identity_map;
CREATE POLICY identity_map_tenant_isolation ON identity_map
  FOR ALL
  TO PUBLIC
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Least-Privilege Role Grants
GRANT SELECT, INSERT ON identity_map TO abate_identity;
GRANT SELECT, INSERT ON identity_map TO abate_app;

-- Explicitly revoke access from background worker (cannot read identity maps)
REVOKE ALL ON identity_map FROM abate_worker;

