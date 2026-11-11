-- backend/db/migrations/0080_worker_daemon.sql
-- Module 1 / Step 2: Worker Daemon, FOR UPDATE SKIP LOCKED Polling, Dead-Letter Queue & Retries
-- Enforces: references only in dead-letter rows, never raw payloads. Least-privilege abate_worker role.

ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE outbox_event ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'PENDING';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_outbox_event_state'
  ) THEN
    ALTER TABLE outbox_event
      ADD CONSTRAINT chk_outbox_event_state
      CHECK (state IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER'));
  END IF;
END $$;

-- Index for concurrent polling with SKIP LOCKED
CREATE INDEX IF NOT EXISTS idx_outbox_event_poll
  ON outbox_event (state, next_retry_at, created_at)
  WHERE published_at IS NULL;

-- Dead-Letter Queue Table: Stores references only, NEVER payloads
CREATE TABLE IF NOT EXISTS dead_letter_event (
  id UUID PRIMARY KEY,
  outbox_id UUID NOT NULL REFERENCES outbox_event(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  aggregate TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  schema_version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  refs JSONB NOT NULL DEFAULT '[]',
  attempts INT NOT NULL,
  last_error TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS on dead_letter_event
ALTER TABLE dead_letter_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_event FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'dead_letter_event') THEN
    CREATE POLICY tenant_isolation ON dead_letter_event
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Worker role privileges for outbox retry state & dead-letter queue
GRANT UPDATE (attempts, next_retry_at, last_error, state, published_at) ON outbox_event TO abate_worker;
GRANT SELECT, INSERT ON dead_letter_event TO abate_worker;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'dead_letter_event' AND policyname = 'worker_dead_letter_access') THEN
    CREATE POLICY worker_dead_letter_access ON dead_letter_event FOR ALL TO abate_worker USING (true) WITH CHECK (true);
  END IF;
END $$;

