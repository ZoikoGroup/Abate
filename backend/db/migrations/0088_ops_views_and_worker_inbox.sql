-- backend/db/migrations/0088_ops_views_and_worker_inbox.sql
-- Track 2 Hardening:
-- 1. Narrow content-free operational view `ops_connector_health` for abate_ops (zero tenant payloads/subjects)
-- 2. Persist optional operator reason on `ai_kill_switch`
-- 3. Durable `worker_consumer_version` high-water mark table for restart-safe out-of-order version detection

-- 1. Content-free connector freshness view for abate_ops (replaces direct connection queries via withPlatform)
CREATE OR REPLACE VIEW ops_connector_health AS
  SELECT id, source, state, last_success_at, expected_cadence_seconds
  FROM connection;

GRANT SELECT ON ops_connector_health TO abate_ops;

-- 2. Record operator reason when toggling kill switches (Completion Plan §7.2)
ALTER TABLE ai_kill_switch
  ADD COLUMN IF NOT EXISTS reason text;

-- 3. Durable worker consumer high-water mark table (no tenant_id / zero workforce data)
CREATE TABLE IF NOT EXISTS worker_consumer_version (
  consumer text NOT NULL,
  aggregate_id uuid NOT NULL,
  last_version int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, aggregate_id)
);

GRANT SELECT, INSERT, UPDATE ON worker_consumer_version TO abate_worker;
