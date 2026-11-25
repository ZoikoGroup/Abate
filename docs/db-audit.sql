-- docs/db-audit.sql
-- Zoiko Abate Database Integrity & Least-Privilege Catalog Audit (Section 5.3)
-- Every query MUST return 0 rows (or expected false attributes) in CI.

-- 1. Tenant tables without ENABLE + FORCE ROW LEVEL SECURITY (expect 0 rows)
SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND EXISTS (
    SELECT 1 FROM information_schema.columns k
    WHERE k.table_schema = 'public'
      AND k.table_name = c.relname
      AND k.column_name = 'tenant_id'
  )
  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);

-- 2. Dangerous role attributes on runtime roles (expect 0 rows; abate_migrator is DDL-only)
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
FROM pg_roles
WHERE rolname LIKE 'abate_%'
  AND rolname <> 'abate_migrator'
  AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb);

-- 3. Tables owned by runtime roles (expect 0 rows)
SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public'
  AND tableowner IN (
    'abate_app',
    'abate_worker',
    'abate_protected_compute',
    'abate_release_compiler',
    'abate_performance',
    'abate_ops',
    'abate_privacy',
    'abate_identity'
  );

-- 4. Web role (abate_app) grants on protected tables (expect 0 rows)
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'abate_app'
  AND table_name IN ('metric_snapshot', 'disclosure_ledger', 'identity_map');

-- 5. RLS-enabled tables with no policy (expect 0 rows)
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = c.relname
  );

-- 6. Missing Section 5.1 least-privilege roles (expect 0 rows)
SELECT expected_role
FROM unnest(ARRAY[
  'abate_migrator',
  'abate_app',
  'abate_worker',
  'abate_identity',
  'abate_protected_compute',
  'abate_release_compiler',
  'abate_performance',
  'abate_ops'
]) AS expected_role
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles r WHERE r.rolname = expected_role
);

-- 7. Narrow operational views missing SELECT grant for abate_ops (expect 0 rows)
SELECT expected_view
FROM unnest(ARRAY['ops_active_tenants', 'ops_connector_health']) AS expected_view
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.role_table_grants g
  WHERE g.grantee = 'abate_ops'
    AND g.table_schema = 'public'
    AND g.table_name = expected_view
    AND g.privilege_type = 'SELECT'
);

-- 8. Durable worker consumer high-water table missing abate_worker privileges (expect 0 rows)
SELECT expected_priv
FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS expected_priv
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.role_table_grants g
  WHERE g.grantee = 'abate_worker'
    AND g.table_schema = 'public'
    AND g.table_name = 'worker_consumer_version'
    AND g.privilege_type = expected_priv
);

-- 9. Published outbox prune DELETE grant missing on outbox_event for abate_worker/abate_ops (0089, expect 0 rows)
SELECT expected_role
FROM unnest(ARRAY['abate_worker', 'abate_ops']) AS expected_role
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.role_table_grants g
  WHERE g.grantee = expected_role
    AND g.table_schema = 'public'
    AND g.table_name = 'outbox_event'
    AND g.privilege_type = 'DELETE'
);

-- 10. Published outbox prune RLS policies missing on outbox_event (0089, expect 0 rows)
SELECT expected_policy
FROM unnest(ARRAY['worker_prune_published', 'ops_prune_published']) AS expected_policy
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'outbox_event'
    AND p.policyname = expected_policy
    AND p.cmd = 'DELETE'
);
