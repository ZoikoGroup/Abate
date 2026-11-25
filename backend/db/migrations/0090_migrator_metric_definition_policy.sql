-- backend/db/migrations/0090_migrator_metric_definition_policy.sql
-- Non-superuser abate_migrator RLS policies under FORCE ROW LEVEL SECURITY:
-- 1. Allows table owner abate_migrator to manage governed metric_definition rows
--    (runtime roles remain SELECT-only; approved rows remain immutable via trigger).
-- 2. Allows view owner abate_migrator to read tenant & connection when executing
--    the narrow, content-free operational views ops_active_tenants (0087) and
--    ops_connector_health (0088) for abate_ops / abate_worker without granting those
--    runtime roles direct SELECT on tenant or connection.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'metric_definition'
      AND policyname = 'metric_definition_migrator_manage'
  ) THEN
    CREATE POLICY metric_definition_migrator_manage ON metric_definition
      FOR ALL TO abate_migrator
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant'
      AND policyname = 'tenant_migrator_ops_view_read'
  ) THEN
    CREATE POLICY tenant_migrator_ops_view_read ON tenant
      FOR SELECT TO abate_migrator
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'connection'
      AND policyname = 'connection_migrator_ops_view_read'
  ) THEN
    CREATE POLICY connection_migrator_ops_view_read ON connection
      FOR SELECT TO abate_migrator
      USING (true);
  END IF;
END $$;
