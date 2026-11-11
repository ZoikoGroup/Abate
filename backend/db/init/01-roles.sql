-- Local-only PostgreSQL bootstrap. These roles are also guarded by 0001_roles.sql
-- and 0062_outbox_worker_role.sql for databases created outside Docker.
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

  -- 0081_phase2_identity_map.sql GRANTs to this role but abate_migrator (NOCREATEROLE) cannot create it,
  -- so a fresh database failed at 0081 with "permission denied to create role".
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_identity') THEN
    CREATE ROLE abate_identity LOGIN PASSWORD 'identity_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT CONNECT ON DATABASE abate TO abate_migrator, abate_app, abate_worker, abate_identity;
GRANT USAGE, CREATE ON SCHEMA public TO abate_migrator;
GRANT USAGE ON SCHEMA public TO abate_app, abate_worker;
