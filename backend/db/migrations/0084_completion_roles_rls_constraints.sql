-- backend/db/migrations/0084_completion_roles_rls_constraints.sql
-- Completion Plan Sections 5.1, 5.2, 5.3, 5.4, 6 & 8:
-- 1. Distinct runtime roles (abate_protected_compute, abate_release_compiler, abate_performance, abate_ops)
-- 2. Revoke web role (abate_app) grants on protected tables (metric_snapshot, disclosure_ledger, identity_map)
-- 3. Complete ENABLE + FORCE ROW LEVEL SECURITY and policies across all tenant/RLS-enabled tables
-- 4. tenant_sector_setting table with forced RLS
-- 5. Connection state CHECK expansion (SUSPENDED, RESUMED, DISCONNECTED alongside ACTIVE, PAUSED, REVOKED)
-- 6. Immutability triggers on audit_event and approved metric_definition rows

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'abate_protected_compute',
    'abate_release_compiler',
    'abate_performance',
    'abate_ops'
  ] LOOP
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format(
          'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
          r,
          replace(r, 'abate_', '') || '_pw'
        );
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      -- Handled by db/init/01-roles.sql when migrator is NOCREATEROLE
      NULL;
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO abate_identity, abate_protected_compute, abate_release_compiler, abate_performance, abate_ops',
    current_database()
  );
END $$;

GRANT USAGE ON SCHEMA public TO
  abate_identity,
  abate_protected_compute,
  abate_release_compiler,
  abate_performance,
  abate_ops;

-- 1. Least-privilege grants for Section 5.1 roles
GRANT SELECT ON work_fact_revision, effective_membership, metric_definition, tenant TO abate_protected_compute;
GRANT SELECT, INSERT, UPDATE ON metric_snapshot TO abate_protected_compute;

GRANT SELECT ON metric_snapshot, metric_definition, ai_kill_switch TO abate_release_compiler;
GRANT SELECT, INSERT, UPDATE ON privacy_decision, privacy_release, released_artifact, disclosure_ledger TO abate_release_compiler;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'disclosure_ledger_id_seq') THEN
    GRANT USAGE, SELECT ON SEQUENCE disclosure_ledger_id_seq TO abate_release_compiler;
  END IF;
END $$;

GRANT SELECT ON outcome_definition, released_artifact, intervention, hazard, privacy_release, feature_flag TO abate_performance;
GRANT SELECT, INSERT, UPDATE ON outcome_evaluation, ai_change_profile, ai_workdesign_assessment, audit_event, outbox_event, idempotency_record TO abate_performance;

GRANT SELECT ON ai_kill_switch, ingest_receipt, outbox_event, dead_letter_event TO abate_ops;
GRANT INSERT, UPDATE ON ai_kill_switch TO abate_ops;

-- Ensure abate_identity has full needed grants for identity_map
GRANT SELECT, INSERT ON identity_map TO abate_identity;

-- Revoke web role (abate_app) direct table grants on protected intermediate/identity tables (Section 5.3 query #4)
REVOKE ALL ON metric_snapshot FROM abate_app;
REVOKE ALL ON disclosure_ledger FROM abate_app;
REVOKE ALL ON identity_map FROM abate_app;

-- 2. Complete FORCE ROW LEVEL SECURITY & missing policies (Section 5.3 queries #1 and #5)
ALTER TABLE inbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_worker_access ON inbox_event;
CREATE POLICY inbox_worker_access ON inbox_event
  FOR ALL TO abate_worker
  USING (true)
  WITH CHECK (true);
DROP POLICY IF EXISTS inbox_tenant_isolation ON inbox_event;
CREATE POLICY inbox_tenant_isolation ON inbox_event
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE metric_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS metric_definition_protected_roles_read ON metric_definition;
CREATE POLICY metric_definition_protected_roles_read ON metric_definition
  FOR SELECT TO abate_protected_compute, abate_release_compiler
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE feature_flag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_flag_performance_read ON feature_flag;
CREATE POLICY feature_flag_performance_read ON feature_flag
  FOR SELECT TO abate_performance
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE outcome_evaluation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outcome_evaluation_performance ON outcome_evaluation;
CREATE POLICY outcome_evaluation_performance ON outcome_evaluation
  FOR ALL TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ai_change_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_change_profile_performance ON ai_change_profile;
CREATE POLICY ai_change_profile_performance ON ai_change_profile
  FOR ALL TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ai_workdesign_assessment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_workdesign_assessment_performance ON ai_workdesign_assessment;
CREATE POLICY ai_workdesign_assessment_performance ON ai_workdesign_assessment
  FOR ALL TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Add missing policy on RLS-enabled evidence_item (Section 5.3 query #5)
DROP POLICY IF EXISTS evidence_item_tenant_isolation ON evidence_item;
CREATE POLICY evidence_item_tenant_isolation ON evidence_item
  USING (
    EXISTS (
      SELECT 1 FROM evidence_package p
      WHERE p.id = evidence_item.package_id
        AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM evidence_package p
      WHERE p.id = evidence_item.package_id
        AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

-- 3. Per-tenant sector pack setting table (Section 5.2 & Wave 2 T-08)
CREATE TABLE IF NOT EXISTS tenant_sector_setting (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  sector_key text NOT NULL CHECK (sector_key IN ('GENERIC', 'LEGAL', 'ACCOUNTING')),
  pack_key text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_sector_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sector_setting FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_sector_setting_isolation ON tenant_sector_setting;
CREATE POLICY tenant_sector_setting_isolation ON tenant_sector_setting
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON tenant_sector_setting TO abate_app;

-- 4. Connection states (G-15: Reversible ACTIVE/PAUSED/SUSPENDED/RESUMED + Terminal DISCONNECTED/REVOKED)
DO $$
DECLARE c_name text;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'connection'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%state%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE connection DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE connection
  ADD CONSTRAINT chk_connection_state
  CHECK (state IN ('ACTIVE', 'PAUSED', 'SUSPENDED', 'RESUMED', 'DISCONNECTED', 'REVOKED'));

-- 5. Immutability triggers (Section 5.4)
CREATE OR REPLACE FUNCTION audit_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_immutable ON audit_event;
CREATE TRIGGER audit_event_immutable
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_no_change();

CREATE OR REPLACE FUNCTION metric_definition_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'APPROVED' AND (
    NEW.definition IS DISTINCT FROM OLD.definition OR
    NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
  ) THEN
    RAISE EXCEPTION 'approved metric_definition is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metric_definition_immutable_guard ON metric_definition;
CREATE TRIGGER metric_definition_immutable_guard
  BEFORE UPDATE ON metric_definition
  FOR EACH ROW EXECUTE FUNCTION metric_definition_immutable();

-- 6. Hot-path composite index on hazard (Section 5.5)
CREATE INDEX IF NOT EXISTS idx_hazard_tenant_disposition ON hazard (tenant_id, disposition);
