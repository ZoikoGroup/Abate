-- backend/db/migrations/0091_ops_views_security_invoker.sql
-- Narrow operational view security boundaries:
-- 1. Drops broad abate_migrator read policies on tenant and connection added in 0090.
-- 2. Sets security_invoker = true on ops_active_tenants and ops_connector_health
--    so views execute under caller identity and RLS instead of view owner (PostgreSQL 15+).
-- 3. Grants narrow, non-sensitive column-level SELECT and RLS read policies to
--    abate_ops and abate_worker (zero workforce/business/credentials access).

-- 1. Drop broad migrator read policies from 0090
DROP POLICY IF EXISTS tenant_migrator_ops_view_read ON tenant;
DROP POLICY IF EXISTS connection_migrator_ops_view_read ON connection;

-- 2. Configure views as security_invoker = true
ALTER VIEW ops_active_tenants SET (security_invoker = true);
ALTER VIEW ops_connector_health SET (security_invoker = true);

-- 3. Grant narrow column-level SELECT on non-sensitive operational columns
-- ops_active_tenants only references tenant(id, region)
GRANT SELECT (id, region) ON tenant TO abate_ops, abate_worker;

-- ops_connector_health only references connection(id, source, state, last_success_at, expected_cadence_seconds)
GRANT SELECT (id, source, state, last_success_at, expected_cadence_seconds) ON connection TO abate_ops;

-- 4. Narrow RLS policies permitting view queries by authorized runtime operational roles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant'
      AND policyname = 'tenant_ops_active_view_read'
  ) THEN
    CREATE POLICY tenant_ops_active_view_read ON tenant
      FOR SELECT TO abate_ops, abate_worker
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection'
      AND policyname = 'connection_ops_health_view_read'
  ) THEN
    CREATE POLICY connection_ops_health_view_read ON connection
      FOR SELECT TO abate_ops
      USING (true);
  END IF;
END $$;
