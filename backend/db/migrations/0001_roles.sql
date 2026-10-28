-- db/migrations/0001_roles.sql
-- Separation of database roles: migrator (schema changes) vs restricted app runtime (no DDL, no BYPASSRLS)

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_migrator') THEN
    CREATE ROLE abate_migrator LOGIN PASSWORD 'migrator_pw' NOSUPERUSER NOBYPASSRLS;
  END IF;
  
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abate_app') THEN
    CREATE ROLE abate_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Database grants
GRANT CONNECT ON DATABASE abate TO abate_app;
GRANT USAGE ON SCHEMA public TO abate_app;

-- Tables are created by abate_migrator, so abate_app never owns them.
ALTER DEFAULT PRIVILEGES FOR ROLE abate_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO abate_app;

ALTER DEFAULT PRIVILEGES FOR ROLE abate_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO abate_app;

