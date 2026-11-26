-- backend/db/migrations/0092_super_admin_platform_ops.sql
-- Super Admin Platform Operations & Tenant Lifecycle Management:
-- 1. Adds tenant lifecycle state ('ACTIVE', 'SUSPENDED') to tenant and projects it in ops_active_tenants.
-- 2. Creates append-only platform_audit_event table with immutability trigger.
-- 3. Grants abate_ops least-privilege metadata administration on tenant, organization,
--    tenant_sector_setting, principal, effective_membership, and feature_flag
--    with ZERO access to workforce/measurement/privacy/hazard tables.

-- 1. Tenant lifecycle state
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ACTIVE'
  CHECK (state IN ('ACTIVE', 'SUSPENDED'));

CREATE OR REPLACE VIEW ops_active_tenants
  WITH (security_invoker = true) AS
  SELECT id, region, state
  FROM tenant;

GRANT SELECT ON ops_active_tenants TO abate_ops, abate_worker;

-- 2. Immutable Platform Admin Audit Log
CREATE TABLE IF NOT EXISTS platform_audit_event (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  operator text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_occurred
  ON platform_audit_event (occurred_at DESC);

GRANT SELECT, INSERT ON platform_audit_event TO abate_ops;
REVOKE UPDATE, DELETE ON platform_audit_event FROM abate_ops, abate_app, abate_worker;

DROP TRIGGER IF EXISTS platform_audit_event_immutable ON platform_audit_event;
CREATE TRIGGER platform_audit_event_immutable
  BEFORE UPDATE OR DELETE ON platform_audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_no_change();

-- 3. Least-privilege platform metadata management for abate_ops (zero workforce/measurement/privacy data)
GRANT SELECT (id, name, region, jurisdiction_config_ref, state, created_at),
      INSERT (id, name, region, jurisdiction_config_ref, state),
      UPDATE (name, region, jurisdiction_config_ref, state)
  ON tenant TO abate_ops;

DROP POLICY IF EXISTS tenant_ops_admin_manage ON tenant;
CREATE POLICY tenant_ops_admin_manage ON tenant
  FOR ALL TO abate_ops
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, tenant_id, parent_id, name),
      INSERT (id, tenant_id, parent_id, name)
  ON organization TO abate_ops;

DROP POLICY IF EXISTS organization_ops_admin_manage ON organization;
CREATE POLICY organization_ops_admin_manage ON organization
  FOR ALL TO abate_ops
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON tenant_sector_setting TO abate_ops;
DROP POLICY IF EXISTS tenant_sector_setting_ops_admin_manage ON tenant_sector_setting;
CREATE POLICY tenant_sector_setting_ops_admin_manage ON tenant_sector_setting
  FOR ALL TO abate_ops
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON principal TO abate_ops;
DROP POLICY IF EXISTS principal_ops_admin_manage ON principal;
CREATE POLICY principal_ops_admin_manage ON principal
  FOR ALL TO abate_ops
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON effective_membership TO abate_ops;
DROP POLICY IF EXISTS effective_membership_ops_admin_manage ON effective_membership;
CREATE POLICY effective_membership_ops_admin_manage ON effective_membership
  FOR ALL TO abate_ops
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON feature_flag TO abate_ops;
DROP POLICY IF EXISTS feature_flag_ops_admin_manage ON feature_flag;
CREATE POLICY feature_flag_ops_admin_manage ON feature_flag
  FOR ALL TO abate_ops
  USING (true)
  WITH CHECK (true);
