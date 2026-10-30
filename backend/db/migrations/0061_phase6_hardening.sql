-- backend/db/migrations/0061_phase6_hardening.sql
-- Review fixes for 0051/0060 (applied as a new migration; merged migrations are not edited).

-- 1. evidence_item had RLS forced but no policy, so abate_app could never read or write it.
--    It has no tenant_id: scope rows through the parent package, which is itself tenant-isolated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'evidence_item' AND policyname = 'evidence_item_via_package') THEN
    CREATE POLICY evidence_item_via_package ON evidence_item
      USING (EXISTS (SELECT 1 FROM evidence_package p WHERE p.id = evidence_item.package_id))
      WITH CHECK (EXISTS (SELECT 1 FROM evidence_package p WHERE p.id = evidence_item.package_id));
  END IF;
END $$;

-- 2. AI use cases and the tool catalog are platform configuration: evaluated and enabled by the platform,
--    never by a tenant session.
REVOKE INSERT, UPDATE, DELETE ON ai_use_case FROM abate_app;
REVOKE INSERT, UPDATE, DELETE ON tool_catalog FROM abate_app;
GRANT SELECT ON ai_use_case, tool_catalog TO abate_app;

-- 3. ai_kill_switch stays writable by abate_app because the ops API flips it; that route now requires a
--    support-operator token and records the operator in changed_by. Switches are never deleted.
REVOKE DELETE ON ai_kill_switch FROM abate_app;
