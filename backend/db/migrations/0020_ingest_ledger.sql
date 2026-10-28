-- db/migrations/0020_ingest_ledger.sql
-- Domain S02 (Ingestion) & S03 (Work-State Ledger)
-- Enforces ingestion without overcollection, atomic fact revisions, and append-only ledger

CREATE TABLE IF NOT EXISTS source_contract (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  source text NOT NULL,
  version text NOT NULL,
  contract_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, version)
);

CREATE TABLE IF NOT EXISTS connection (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  source text NOT NULL,
  contract_id uuid NOT NULL REFERENCES source_contract(id),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  last_success_at timestamptz,
  expected_cadence_seconds int NOT NULL DEFAULT 3600,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS watermark (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connection_id uuid NOT NULL,
  cursor text NOT NULL,
  advanced_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, connection_id)
);

CREATE TABLE IF NOT EXISTS ingest_receipt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connection_id uuid NOT NULL,
  batch_id text NOT NULL,
  accepted int NOT NULL,
  duplicate int NOT NULL,
  rejected int NOT NULL,
  conflicted int NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connection_id, batch_id)
);

CREATE TABLE IF NOT EXISTS work_fact_revision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connection_id uuid NOT NULL,
  source_record_id text NOT NULL,
  revision int NOT NULL,
  subject_pseudonym text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  work_tz text NOT NULL,
  kind text NOT NULL,
  payload_hash text NOT NULL,
  receipt_id uuid NOT NULL REFERENCES ingest_receipt(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connection_id, source_record_id, revision),
  CHECK (end_at > start_at)
);

-- Forced Row-Level Security on all Ingest & Ledger tables
ALTER TABLE source_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_contract FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'source_contract') THEN
    CREATE POLICY tenant_isolation ON source_contract
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'connection') THEN
    CREATE POLICY tenant_isolation ON connection
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE watermark ENABLE ROW LEVEL SECURITY;
ALTER TABLE watermark FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'watermark') THEN
    CREATE POLICY tenant_isolation ON watermark
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE ingest_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_receipt FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'ingest_receipt') THEN
    CREATE POLICY tenant_isolation ON ingest_receipt
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE work_fact_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_fact_revision FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'work_fact_revision') THEN
    CREATE POLICY tenant_isolation ON work_fact_revision
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

