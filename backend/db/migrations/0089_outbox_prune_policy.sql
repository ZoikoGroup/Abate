-- backend/db/migrations/0089_outbox_prune_policy.sql
-- Completion Plan §5.5 & Playbook §5.5: Published Outbox Pruning
-- Allows abate_worker and abate_ops to prune strictly PUBLISHED outbox rows.
-- RLS guarantees that PENDING, PROCESSING, and DEAD_LETTER events cannot be deleted.

GRANT DELETE ON outbox_event TO abate_worker;
GRANT DELETE ON outbox_event TO abate_ops;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'outbox_event' AND policyname = 'worker_prune_published') THEN
    CREATE POLICY worker_prune_published ON outbox_event FOR DELETE TO abate_worker
      USING (state = 'PUBLISHED' AND published_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'outbox_event' AND policyname = 'ops_prune_published') THEN
    CREATE POLICY ops_prune_published ON outbox_event FOR DELETE TO abate_ops
      USING (state = 'PUBLISHED' AND published_at IS NOT NULL);
  END IF;
END $$;
