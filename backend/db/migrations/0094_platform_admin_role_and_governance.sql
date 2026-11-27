-- backend/db/migrations/0094_platform_admin_role_and_governance.sql
-- Admin Security Foundation & Tenant Admin Schema:
-- 1. Creates dedicated runtime role `abate_platform_admin` (NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE)
--    with column-limited grants and dedicated RLS policies on platform/tenant metadata ONLY.
--    ZERO grants on tenant workforce, measurement, privacy, hazard, control, AI-run, or invitation tables.
-- 2. Tightens `abate_ops` back down by removing 0092 broad admin write grants and policies.
-- 3. Adds four-eyes approval queue (`admin_approval_request` with DB-level self-approval CHECK),
--    named platform accounts (`platform_user`), tenant AI quota config (`tenant_ai_quota_config`),
--    tenant commercial entitlements (`tenant_entitlement`), and tenant OIDC invitations (`tenant_invitation`).
-- 4. Adds optimistic locking (`version`), offboarding request metadata, principal deactivation,
--    kill-switch optional expiry, and `request_id` / `approver` / `step_up_verified` audit columns.

-- 1. Dedicated runtime role guard (also created in db/init/01-roles.sql)
DO $$
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abate_platform_admin') THEN
      CREATE ROLE abate_platform_admin LOGIN PASSWORD 'platform_admin_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO abate_platform_admin', current_database());
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    GRANT USAGE ON SCHEMA public TO abate_platform_admin;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

-- 2. Tighten abate_ops back down (revoke 0092 admin write grants & drop 0092 broad policies)
DROP POLICY IF EXISTS tenant_ops_admin_manage ON tenant;
DROP POLICY IF EXISTS organization_ops_admin_manage ON organization;
DROP POLICY IF EXISTS tenant_sector_setting_ops_admin_manage ON tenant_sector_setting;
DROP POLICY IF EXISTS principal_ops_admin_manage ON principal;
DROP POLICY IF EXISTS effective_membership_ops_admin_manage ON effective_membership;
DROP POLICY IF EXISTS feature_flag_ops_admin_manage ON feature_flag;

REVOKE ALL ON tenant FROM abate_ops;
REVOKE ALL ON organization FROM abate_ops;
REVOKE ALL ON tenant_sector_setting FROM abate_ops;
REVOKE ALL ON principal FROM abate_ops;
REVOKE ALL ON effective_membership FROM abate_ops;
REVOKE ALL ON feature_flag FROM abate_ops;

-- Restore strictly narrow column-level SELECT required by ops_active_tenants (security_invoker)
GRANT SELECT (id, region, state) ON tenant TO abate_ops;

-- 3. Additive metadata, versioning (If-Match), deactivation & audit columns
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS offboard_requested_at timestamptz;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS offboard_reason text;

ALTER TABLE organization ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE principal ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE principal ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE principal ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE effective_membership ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE connection ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE legal_hold ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

ALTER TABLE ai_kill_switch ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE platform_audit_event ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE platform_audit_event ADD COLUMN IF NOT EXISTS approver text;
ALTER TABLE platform_audit_event ADD COLUMN IF NOT EXISTS step_up_verified boolean NOT NULL DEFAULT false;

-- 4. Named Platform Staff Accounts (Platform Super Admin & Ops/Support)
CREATE TABLE IF NOT EXISTS platform_user (
  id uuid PRIMARY KEY,
  subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  platform_role text NOT NULL CHECK (platform_role IN ('SUPER_ADMIN', 'OPS_SUPPORT')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  break_glass boolean NOT NULL DEFAULT false,
  mfa_enforced boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);

-- 5. Four-Eyes Approval Queue (self-approval refused at DB constraint level too)
CREATE TABLE IF NOT EXISTS admin_approval_request (
  id uuid PRIMARY KEY,
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED')),
  approved_by text,
  approved_at timestamptz,
  decision_reason text,
  executed_at timestamptz,
  expires_at timestamptz NOT NULL,
  request_id text,
  version int NOT NULL DEFAULT 1,
  CONSTRAINT chk_four_eyes_distinct_approver CHECK (approved_by IS NULL OR lower(approved_by) <> lower(requested_by))
);

CREATE INDEX IF NOT EXISTS idx_admin_approval_status ON admin_approval_request (status, requested_at DESC);

-- 6. Per-Tenant AI Quota Configuration (platform metadata only; forced RLS)
CREATE TABLE IF NOT EXISTS tenant_ai_quota_config (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  monthly_budget_minor bigint NOT NULL DEFAULT 50000 CHECK (monthly_budget_minor >= 0),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);

ALTER TABLE tenant_ai_quota_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_quota_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_ai_quota_config_tenant_read ON tenant_ai_quota_config;
CREATE POLICY tenant_ai_quota_config_tenant_read ON tenant_ai_quota_config
  FOR SELECT TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_ai_quota_config_ops_read ON tenant_ai_quota_config;
CREATE POLICY tenant_ai_quota_config_ops_read ON tenant_ai_quota_config
  FOR SELECT TO abate_ops
  USING (true);

DROP POLICY IF EXISTS tenant_ai_quota_config_admin_manage ON tenant_ai_quota_config;
CREATE POLICY tenant_ai_quota_config_admin_manage ON tenant_ai_quota_config
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON tenant_ai_quota_config TO abate_app, abate_ops;

-- 7. Per-Tenant Commercial Entitlements (Entitlement AND Policy; zero privacy input; forced RLS)
CREATE TABLE IF NOT EXISTS tenant_entitlement (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  notes text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, feature_key)
);

ALTER TABLE tenant_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlement FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_entitlement_tenant_read ON tenant_entitlement;
CREATE POLICY tenant_entitlement_tenant_read ON tenant_entitlement
  FOR SELECT TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_entitlement_admin_manage ON tenant_entitlement;
CREATE POLICY tenant_entitlement_admin_manage ON tenant_entitlement
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON tenant_entitlement TO abate_app;

-- 8. Tenant Admin OIDC Invitations (strictly tenant-isolated; zero platform_admin/ops access)
CREATE TABLE IF NOT EXISTS tenant_invitation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL REFERENCES organization(id),
  masked_email text NOT NULL,
  email_hash text NOT NULL,
  external_subject text,
  domain_role text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  invited_by uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  version int NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitation_tenant_status ON tenant_invitation (tenant_id, status, created_at DESC);

ALTER TABLE tenant_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invitation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_invitation_isolation ON tenant_invitation;
CREATE POLICY tenant_invitation_isolation ON tenant_invitation
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_invitation TO abate_app;
GRANT SELECT, INSERT, UPDATE ON principal, effective_membership, organization TO abate_app;

-- 9. Column-limited grants and dedicated RLS policies for abate_platform_admin
GRANT SELECT (id, name, region, jurisdiction_config_ref, state, version, offboard_requested_at, offboard_reason, created_at),
      INSERT (id, name, region, jurisdiction_config_ref, state, version),
      UPDATE (name, region, jurisdiction_config_ref, state, version, offboard_requested_at, offboard_reason)
  ON tenant TO abate_platform_admin;

DROP POLICY IF EXISTS tenant_platform_admin_manage ON tenant;
CREATE POLICY tenant_platform_admin_manage ON tenant
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, tenant_id, parent_id, name, version),
      INSERT (id, tenant_id, parent_id, name, version)
  ON organization TO abate_platform_admin;

DROP POLICY IF EXISTS organization_platform_admin_manage ON organization;
CREATE POLICY organization_platform_admin_manage ON organization
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT (tenant_id, sector_key, pack_key, updated_by, updated_at),
      INSERT (tenant_id, sector_key, pack_key, updated_by, updated_at),
      UPDATE (sector_key, pack_key, updated_by, updated_at)
  ON tenant_sector_setting TO abate_platform_admin;

DROP POLICY IF EXISTS tenant_sector_setting_platform_admin_manage ON tenant_sector_setting;
CREATE POLICY tenant_sector_setting_platform_admin_manage ON tenant_sector_setting
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, tenant_id, external_subject, kind, active, deactivated_at, version),
      INSERT (id, tenant_id, external_subject, kind, active, version)
  ON principal TO abate_platform_admin;

DROP POLICY IF EXISTS principal_platform_admin_manage ON principal;
CREATE POLICY principal_platform_admin_manage ON principal
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, version),
      INSERT (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, version),
      UPDATE (valid_to, version)
  ON effective_membership TO abate_platform_admin;

DROP POLICY IF EXISTS effective_membership_platform_admin_manage ON effective_membership;
CREATE POLICY effective_membership_platform_admin_manage ON effective_membership
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT (tenant_id, flag, enabled, changed_by, changed_at),
      INSERT (tenant_id, flag, enabled, changed_by, changed_at),
      UPDATE (enabled, changed_by, changed_at)
  ON feature_flag TO abate_platform_admin;

DROP POLICY IF EXISTS feature_flag_platform_admin_manage ON feature_flag;
CREATE POLICY feature_flag_platform_admin_manage ON feature_flag
  FOR ALL TO abate_platform_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT (scope, active, changed_by, changed_at, reason, expires_at),
      INSERT (scope, active, changed_by, changed_at, reason, expires_at),
      UPDATE (active, changed_by, changed_at, reason, expires_at)
  ON ai_kill_switch TO abate_platform_admin;

GRANT SELECT (id, source, state, last_success_at, expected_cadence_seconds)
  ON connection TO abate_platform_admin;

DROP POLICY IF EXISTS connection_platform_admin_health_read ON connection;
CREATE POLICY connection_platform_admin_health_read ON connection
  FOR SELECT TO abate_platform_admin
  USING (true);

GRANT SELECT ON ops_active_tenants, ops_connector_health TO abate_platform_admin;

REVOKE ALL ON platform_audit_event FROM abate_ops, abate_app, abate_worker;
GRANT SELECT, INSERT ON platform_audit_event TO abate_platform_admin;
REVOKE UPDATE, DELETE ON platform_audit_event FROM abate_platform_admin;

GRANT SELECT (id, subject, display_name, platform_role, status, break_glass, mfa_enforced, created_at, updated_at, version),
      INSERT (id, subject, display_name, platform_role, status, break_glass, mfa_enforced, version),
      UPDATE (display_name, platform_role, status, break_glass, mfa_enforced, updated_at, version)
  ON platform_user TO abate_platform_admin;

GRANT SELECT (id, action_type, target_type, target_id, payload, reason, requested_by, requested_at, status, approved_by, approved_at, decision_reason, executed_at, expires_at, request_id, version),
      INSERT (id, action_type, target_type, target_id, payload, reason, requested_by, requested_at, status, expires_at, request_id, version),
      UPDATE (status, approved_by, approved_at, decision_reason, executed_at, version)
  ON admin_approval_request TO abate_platform_admin;

GRANT SELECT (tenant_id, monthly_budget_minor, updated_by, updated_at, version),
      INSERT (tenant_id, monthly_budget_minor, updated_by, updated_at, version),
      UPDATE (monthly_budget_minor, updated_by, updated_at, version)
  ON tenant_ai_quota_config TO abate_platform_admin;

GRANT SELECT (tenant_id, feature_key, enabled, notes, updated_by, updated_at, version),
      INSERT (tenant_id, feature_key, enabled, notes, updated_by, updated_at, version),
      UPDATE (enabled, notes, updated_by, updated_at, version)
  ON tenant_entitlement TO abate_platform_admin;
