-- backend/db/migrations/0086_open_sector_key.sql
-- Sector packs are now a registry (domains/lifecycle/sector-registry.ts), not a fixed list.
-- The three-value CHECK on tenant_sector_setting.sector_key blocked every new sector.
-- Replace it with a format check. The application validates the key against the registry on write,
-- and the resolver fails closed to the neutral GENERIC baseline for a key that is no longer registered.

DO $$
DECLARE c_name text;
BEGIN
  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'tenant_sector_setting'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%sector_key%IN%'
  LOOP
    EXECUTE format('ALTER TABLE tenant_sector_setting DROP CONSTRAINT %I', c_name);
  END LOOP;
END $$;

ALTER TABLE tenant_sector_setting DROP CONSTRAINT IF EXISTS tenant_sector_setting_sector_key_format;
ALTER TABLE tenant_sector_setting
  ADD CONSTRAINT tenant_sector_setting_sector_key_format
  CHECK (sector_key ~ '^[A-Z][A-Z0-9_]{1,31}$');
