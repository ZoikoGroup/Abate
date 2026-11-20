-- backend/db/migrations/0087_async_jobs_and_role_policies.sql
-- Additive Completion Plan updates (Zero code/table removal):
-- 1. Durable tenant-isolated async_job table (persists /api/v2/jobs/:id across restarts)
-- 2. Explicit read-only RLS policies for abate_performance on Plane A reference tables
-- 3. Narrow content-free ops_active_tenants view (id, region, state) for multi-tenant worker/ops discovery

-- 1. Durable async_job table with forced RLS
CREATE TABLE IF NOT EXISTS async_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  job_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  progress int NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  result_summary jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_async_job_tenant_created
  ON async_job (tenant_id, created_at DESC);

ALTER TABLE async_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE async_job FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS async_job_tenant_isolation ON async_job;
CREATE POLICY async_job_tenant_isolation ON async_job
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON async_job TO abate_app, abate_worker;

-- 2. Explicit read-only RLS policies for abate_performance on Plane A reference & outcome definition tables
DROP POLICY IF EXISTS outcome_definition_performance_read ON outcome_definition;
CREATE POLICY outcome_definition_performance_read ON outcome_definition
  FOR SELECT TO abate_performance
  USING (true);

DROP POLICY IF EXISTS released_artifact_performance_read ON released_artifact;
CREATE POLICY released_artifact_performance_read ON released_artifact
  FOR SELECT TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS privacy_release_performance_read ON privacy_release;
CREATE POLICY privacy_release_performance_read ON privacy_release
  FOR SELECT TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS intervention_performance_read ON intervention;
CREATE POLICY intervention_performance_read ON intervention
  FOR SELECT TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS hazard_performance_read ON hazard;
CREATE POLICY hazard_performance_read ON hazard
  FOR SELECT TO abate_performance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Narrow content-free operational view for multi-tenant worker & ops discovery (zero workforce/business data)
CREATE OR REPLACE VIEW ops_active_tenants AS
  SELECT id, region, state
  FROM tenant
  WHERE state = 'ACTIVE';

GRANT SELECT ON ops_active_tenants TO abate_ops, abate_worker;
