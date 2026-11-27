-- Local-only PostgreSQL bootstrap. These roles are also guarded by 0001_roles.sql,
-- 0062_outbox_worker_role.sql, and 0084_completion_roles_rls_constraints.sql for databases created outside Docker.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_migrator') THEN
    CREATE ROLE abate_migrator LOGIN PASSWORD 'migrator_pw' NOSUPERUSER NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_app') THEN
    CREATE ROLE abate_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_worker') THEN
    CREATE ROLE abate_worker LOGIN PASSWORD 'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- 0081_phase2_identity_map.sql and 0082_phase3_privacy_roles.sql GRANT to these roles,
  -- but abate_migrator (NOCREATEROLE) cannot create them on a fresh non-superuser database.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_identity') THEN
    CREATE ROLE abate_identity LOGIN PASSWORD 'identity_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_privacy') THEN
    CREATE ROLE abate_privacy LOGIN PASSWORD 'privacy_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_protected_compute') THEN
    CREATE ROLE abate_protected_compute LOGIN PASSWORD 'protected_compute_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_release_compiler') THEN
    CREATE ROLE abate_release_compiler LOGIN PASSWORD 'release_compiler_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_performance') THEN
    CREATE ROLE abate_performance LOGIN PASSWORD 'performance_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_ops') THEN
    CREATE ROLE abate_ops LOGIN PASSWORD 'ops_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_platform_admin') THEN
    CREATE ROLE abate_platform_admin LOGIN PASSWORD 'platform_admin_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT CONNECT ON DATABASE abate TO
  abate_migrator,
  abate_app,
  abate_worker,
  abate_identity,
  abate_privacy,
  abate_protected_compute,
  abate_release_compiler,
  abate_performance,
  abate_ops,
  abate_platform_admin;

GRANT USAGE, CREATE ON SCHEMA public TO abate_migrator;
GRANT USAGE ON SCHEMA public TO
  abate_app,
  abate_worker,
  abate_identity,
  abate_privacy,
  abate_protected_compute,
  abate_release_compiler,
  abate_performance,
  abate_ops,
  abate_platform_admin;
