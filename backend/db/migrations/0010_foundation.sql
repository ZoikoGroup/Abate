-- db/migrations/0010_foundation.sql
-- Domain S01: Identity, Tenancy and Organization Schema with Forced Row-Level Security

CREATE TABLE IF NOT EXISTS tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL,
  jurisdiction_config_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principal (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  external_subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('USER', 'WORKLOAD')),
  UNIQUE (tenant_id, external_subject),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS organization (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  parent_id uuid,
  name text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES organization(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS effective_membership (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  domain_role text NOT NULL, -- e.g. RISK_OWNER, CONTROL_OWNER, REVIEWER, EMPLOYER_ADMIN
  valid_from timestamptz NOT NULL,
  valid_to timestamptz, -- [valid_from, valid_to) interval
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES principal(tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Row-Level Security: ENABLE & FORCE on all tenant-owned tables
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'tenant') THEN
    CREATE POLICY tenant_isolation ON tenant
      USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'principal') THEN
    CREATE POLICY tenant_isolation ON principal
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'organization') THEN
    CREATE POLICY tenant_isolation ON organization
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

ALTER TABLE effective_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE effective_membership FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'effective_membership') THEN
    CREATE POLICY tenant_isolation ON effective_membership
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

