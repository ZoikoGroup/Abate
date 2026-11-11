-- 0083: tighten grants that the default privileges in 0001 made too broad.
--
-- 0001 grants SELECT, INSERT, UPDATE on every migrator-created table to abate_app. Two tables must not be writable
-- by the tenant-facing application role:
--   * inbox_event      - consumer receipts, written only by the outbox worker role (abate_worker)
--   * metric_definition - governed definitions (global rows have tenant_id NULL); changed by migrations only, and it
--                         had no row-level security, so any tenant request could rewrite a global definition.
-- The application only ever reads metric_definition.

REVOKE INSERT, UPDATE, DELETE ON inbox_event FROM abate_app;
REVOKE INSERT, UPDATE, DELETE ON metric_definition FROM abate_app;

-- Reads stay open to global definitions plus the caller's own tenant-specific ones.
ALTER TABLE metric_definition ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS metric_definition_read ON metric_definition;
CREATE POLICY metric_definition_read ON metric_definition
  FOR SELECT TO abate_app
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
