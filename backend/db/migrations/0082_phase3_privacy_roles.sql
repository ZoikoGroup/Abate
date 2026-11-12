-- 0082_phase3_privacy_roles.sql
-- Phase 3 Hardening: Privacy Role Least-Privilege & Worker Boundary Separation
-- Architecture Ref: ZAB-ENG-001 v1.0 / Package B3 (Domain S04 & S06)
-- Guarantees: Protected metric snapshots and disclosure ledgers are isolated from abate_worker.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abate_privacy') THEN
    CREATE ROLE abate_privacy WITH LOGIN PASSWORD 'privacy_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Grants to dedicated privacy engine role and app role
GRANT SELECT, INSERT, UPDATE ON metric_definition TO abate_privacy;
GRANT SELECT, INSERT, UPDATE ON metric_snapshot TO abate_privacy;
GRANT SELECT, INSERT, UPDATE ON privacy_decision TO abate_privacy;
GRANT SELECT, INSERT, UPDATE ON privacy_release TO abate_privacy;
GRANT SELECT, INSERT, UPDATE ON released_artifact TO abate_privacy;
GRANT SELECT, INSERT, UPDATE ON disclosure_ledger TO abate_privacy;

GRANT SELECT, INSERT, UPDATE ON metric_definition TO abate_app;
GRANT SELECT, INSERT, UPDATE ON metric_snapshot TO abate_app;
GRANT SELECT, INSERT, UPDATE ON privacy_decision TO abate_app;
GRANT SELECT, INSERT, UPDATE ON privacy_release TO abate_app;
GRANT SELECT, INSERT, UPDATE ON released_artifact TO abate_app;
GRANT SELECT, INSERT, UPDATE ON disclosure_ledger TO abate_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'disclosure_ledger_id_seq') THEN
    GRANT USAGE, SELECT ON SEQUENCE disclosure_ledger_id_seq TO abate_privacy;
    GRANT USAGE, SELECT ON SEQUENCE disclosure_ledger_id_seq TO abate_app;
  END IF;
END $$;

-- Explicitly revoke access from background worker (cannot read privacy or metric tables)
REVOKE ALL ON metric_snapshot FROM abate_worker;
REVOKE ALL ON privacy_decision FROM abate_worker;
REVOKE ALL ON privacy_release FROM abate_worker;
REVOKE ALL ON released_artifact FROM abate_worker;
REVOKE ALL ON disclosure_ledger FROM abate_worker;

