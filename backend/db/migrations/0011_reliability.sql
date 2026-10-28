-- db/migrations/0011_reliability.sql
-- Idempotency, Audit Log, Transactional Outbox and Consumer Inbox

CREATE TABLE IF NOT EXISTS idempotency_record (
  tenant_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'DONE')),
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_event (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_id uuid,
  purpose text,
  command text NOT NULL,
  resource_type text,
  resource_id uuid,
  resource_version int,
  result text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  aggregate text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version int NOT NULL,
  event_type text NOT NULL,
  schema_version text NOT NULL,
  purpose text NOT NULL,
  refs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE TABLE IF NOT EXISTS inbox_event (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  received_at timestamptz DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- RLS on reliability tables
ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'idempotency_record') THEN
    CREATE POLICY tenant_isolation ON idempotency_record
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'audit_event') THEN
    CREATE POLICY tenant_isolation ON audit_event
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'outbox_event') THEN
    CREATE POLICY tenant_isolation ON outbox_event
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Append-only enforcement: abate_app cannot modify or delete audit events
REVOKE UPDATE, DELETE ON audit_event FROM abate_app;

