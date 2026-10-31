-- backend/db/migrations/0062_outbox_worker_role.sql
-- The outbox drainer serves every tenant, but outbox_event is tenant-isolated by RLS, so a worker with no
-- tenant context saw zero rows. Give it its own least-privilege role instead of BYPASSRLS or the app role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_worker') THEN
    CREATE ROLE abate_worker LOGIN PASSWORD 'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT CONNECT ON DATABASE abate TO abate_worker;
GRANT USAGE ON SCHEMA public TO abate_worker;

-- Only what draining needs: read unpublished events, stamp published_at, record consumer receipt
GRANT SELECT ON outbox_event TO abate_worker;
GRANT UPDATE (published_at) ON outbox_event TO abate_worker;
GRANT SELECT, INSERT ON inbox_event TO abate_worker;

-- Permissive policies are OR'd with tenant_isolation: tenants still see only their own rows,
-- the worker role sees all rows of these two tables and nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'outbox_event' AND policyname = 'worker_drain_read') THEN
    CREATE POLICY worker_drain_read ON outbox_event FOR SELECT TO abate_worker USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'outbox_event' AND policyname = 'worker_drain_mark') THEN
    CREATE POLICY worker_drain_mark ON outbox_event FOR UPDATE TO abate_worker USING (true) WITH CHECK (true);
  END IF;
END $$;
