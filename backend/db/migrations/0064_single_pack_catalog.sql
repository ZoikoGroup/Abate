-- backend/db/migrations/0064_single_pack_catalog.sql
-- 0050 (jurisdiction_pack) and 0051 (policy_pack) were two catalogs for the same concept.
-- policy_pack follows the B5 specification, so it becomes the only catalog: retention classes are validated
-- against the tenant's bound JURISDICTION pack (tenant_policy_binding) and reference it here.

ALTER TABLE retention_class DROP CONSTRAINT IF EXISTS retention_class_pack_id_pack_version_fkey;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retention_class_policy_pack_fkey') THEN
    ALTER TABLE retention_class
      ADD CONSTRAINT retention_class_policy_pack_fkey
      FOREIGN KEY (pack_id, pack_version) REFERENCES policy_pack(pack_key, version);
  END IF;
END $$;

COMMENT ON COLUMN retention_class.pack_id IS 'policy_pack.pack_key of the JURISDICTION pack the duration was validated against';

DROP TABLE IF EXISTS jurisdiction_pack;
