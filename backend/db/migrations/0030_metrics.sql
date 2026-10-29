-- db/migrations/0030_metrics.sql
-- Domain S04 (Measurement) & S06 (Privacy Release)
-- Phase 3: Deterministic measurement and race-safe privacy release

CREATE TABLE IF NOT EXISTS metric_definition (
  metric_id text NOT NULL,
  version int NOT NULL,
  tenant_id uuid, -- NULL = global definition
  definition jsonb NOT NULL,
  definition_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'RETIRED')),
  approved_by uuid,
  approved_at timestamptz,
  PRIMARY KEY (metric_id, version)
);

CREATE TABLE IF NOT EXISTS metric_snapshot (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  metric_id text NOT NULL,
  metric_version int NOT NULL,
  cohort_ref text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  source_cutoff timestamptz NOT NULL,
  code_digest text NOT NULL,
  membership_version text NOT NULL,
  value numeric,
  quality text NOT NULL CHECK (quality IN ('VALID', 'PARTIAL', 'STALE', 'INSUFFICIENT_DATA', 'NOT_APPLICABLE')),
  contributor_count int NOT NULL, -- protected intermediate; NEVER crosses to employer channels
  lineage jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS privacy_decision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  semantic_query_hash text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('RELEASED', 'SUPPRESSED', 'DENIED')),
  reason_code text NOT NULL, -- internal audit reason; NEVER carries counts to the client
  policy_version text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS privacy_release (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  decision_id uuid NOT NULL REFERENCES privacy_decision(id),
  snapshot_id uuid NOT NULL REFERENCES metric_snapshot(id),
  metric_id text NOT NULL,
  metric_version int NOT NULL,
  release_class text NOT NULL,
  status text NOT NULL CHECK (status IN ('RELEASED', 'STALE', 'WITHDRAWN', 'SUPERSEDED')),
  superseded_by uuid,
  released_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS released_artifact (
  release_id uuid PRIMARY KEY REFERENCES privacy_release(id),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  metric_id text NOT NULL,
  metric_version int NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  quality text NOT NULL,
  interpretation text NOT NULL,
  status text NOT NULL,
  artifact_hash text NOT NULL
  -- NOTE: Zero contributor_count column exists here; privacy by construction
);

CREATE TABLE IF NOT EXISTS disclosure_ledger (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  metric_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  cohort_set_hash text NOT NULL,
  cohort_members text NOT NULL, -- serialized set of member pseudonyms/IDs
  release_id uuid NOT NULL REFERENCES privacy_release(id)
);

-- Forced Row-Level Security on Phase 3 Tables
ALTER TABLE metric_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_snapshot FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'metric_snapshot') THEN
    CREATE POLICY tenant_isolation ON metric_snapshot
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE privacy_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_decision FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'privacy_decision') THEN
    CREATE POLICY tenant_isolation ON privacy_decision
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE privacy_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_release FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'privacy_release') THEN
    CREATE POLICY tenant_isolation ON privacy_release
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE released_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE released_artifact FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'released_artifact') THEN
    CREATE POLICY tenant_isolation ON released_artifact
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE disclosure_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure_ledger FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'disclosure_ledger') THEN
    CREATE POLICY tenant_isolation ON disclosure_ledger
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

