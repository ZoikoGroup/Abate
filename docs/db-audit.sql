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
