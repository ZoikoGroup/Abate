-- backend/db/migrations/0063_corrections.sql
-- Late corrections (Playbook B5 §3 Step 8) were never persisted: acknowledgement accepted any id.
-- Record each correction, what it made stale, and who reviewed it.

CREATE TABLE IF NOT EXISTS correction (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connection_id uuid NOT NULL,
  source_record_id text NOT NULL,
  revision int NOT NULL CHECK (revision > 1),
  affected_start timestamptz NOT NULL, -- span covering every revision's interval for the record
  affected_end timestamptz NOT NULL,
  impacted_releases jsonb NOT NULL,
  impacted_packages jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('STALE_MARKED', 'ACKNOWLEDGED')),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  reviewer_notes text,
  CHECK (affected_end > affected_start),
  CHECK ((status = 'ACKNOWLEDGED') = (acknowledged_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_correction_tenant_status ON correction(tenant_id, status);

ALTER TABLE correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'correction' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON correction
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

REVOKE DELETE ON correction FROM abate_app;
