-- backend/db/migrations/0085_dead_letter_replay.sql
-- Completion Plan Section 6 (Worker & Jobs): Human-approved dead-letter replay audit columns.
-- Preserves dead-letter rows permanently with operator attribution and reason rather than deleting them.

ALTER TABLE dead_letter_event ADD COLUMN IF NOT EXISTS replayed_at TIMESTAMPTZ;
ALTER TABLE dead_letter_event ADD COLUMN IF NOT EXISTS replayed_by TEXT;
ALTER TABLE dead_letter_event ADD COLUMN IF NOT EXISTS replay_reason TEXT;

GRANT UPDATE (replayed_at, replayed_by, replay_reason) ON dead_letter_event TO abate_worker;
