-- backend/db/migrations/0051_governance_evidence.sql
-- Phase 5 (Playbook package B5, domains S10 Governance and Evidence, S11 Commercial, S12 Lifecycle)
-- Source: Zoiko Abate Engineering Playbook ZAB-ENG-001 v1.0 (Oct 15, 2026)

-- 1. Policy Pack Catalog: Multi-kind (JURISDICTION, SECTOR, CUSTOMER), effective-dated, versioned
CREATE TABLE IF NOT EXISTS policy_pack (
  id uuid PRIMARY KEY,
  pack_key text NOT NULL,
  version int NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('JURISDICTION', 'SECTOR', 'CUSTOMER')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'WITHDRAWN')),
  source_refs jsonb NOT NULL,
  accountable_reviewer text NOT NULL,
  review_date date NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  UNIQUE (pack_key, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

REVOKE INSERT, UPDATE, DELETE ON policy_pack FROM abate_app;
GRANT SELECT ON policy_pack TO abate_app;

-- 2. Tenant Policy Bindings: Maps which packs a tenant uses (separate from cloud region)
CREATE TABLE IF NOT EXISTS tenant_policy_binding (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  pack_key text NOT NULL,
  pack_version int NOT NULL,
  applies_to jsonb NOT NULL, -- e.g. customer entity, locations, sector, feature
  bound_from timestamptz NOT NULL,
  bound_to timestamptz,
  PRIMARY KEY (tenant_id, pack_key, bound_from)
);

-- 3. Decision Envelope: Stored with every material decision for historical reconstruction
CREATE TABLE IF NOT EXISTS decision_envelope (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  decision_type text NOT NULL,
  resource_id uuid NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  resolution jsonb NOT NULL, -- pack keys + versions actually applied at decision moment
  metric_versions jsonb,
  privacy_profile text,
  sector_pack text,
  model_prompt_versions jsonb
);

-- 4. Evidence Package & Content-Addressed Items
CREATE TABLE IF NOT EXISTS evidence_package (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  scope jsonb NOT NULL,
  cutoff timestamptz NOT NULL,
  issuer_principal_id uuid NOT NULL,
  classification text NOT NULL CHECK (classification IN ('RESTRICTED', 'CONFIDENTIAL', 'PUBLIC')),
  manifest_hash text NOT NULL,
  supersedes_id uuid REFERENCES evidence_package(id),
  superseded_by_id uuid REFERENCES evidence_package(id),
  state text NOT NULL CHECK (state IN ('ISSUED', 'SUPERSEDED', 'WITHDRAWN')),
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_item (
  package_id uuid NOT NULL REFERENCES evidence_package(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  item_version int NOT NULL,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  PRIMARY KEY (package_id, item_type, item_id, item_version)
);

-- 5. Subject Rights Request (GDPR Art 17 Erasure)
CREATE TABLE IF NOT EXISTS rights_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  subject_pseudonym text NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'REJECTED')),
  deleted_count int NOT NULL DEFAULT 0,
  held_exceptions int NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_tenant_policy_binding_tenant ON tenant_policy_binding(tenant_id);
CREATE INDEX IF NOT EXISTS idx_decision_envelope_resource ON decision_envelope(tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_evidence_package_tenant ON evidence_package(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_rights_request_tenant ON rights_request(tenant_id, status);

-- 7. Forced Row-Level Security on all tenant-owned tables
DO $$
BEGIN
  EXECUTE 'ALTER TABLE tenant_policy_binding ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_policy_binding FORCE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE decision_envelope ENABLE ROW LEVEL SECURITY; ALTER TABLE decision_envelope FORCE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE evidence_package ENABLE ROW LEVEL SECURITY; ALTER TABLE evidence_package FORCE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE evidence_item ENABLE ROW LEVEL SECURITY; ALTER TABLE evidence_item FORCE ROW LEVEL SECURITY;';
  EXECUTE 'ALTER TABLE rights_request ENABLE ROW LEVEL SECURITY; ALTER TABLE rights_request FORCE ROW LEVEL SECURITY;';

  DROP POLICY IF EXISTS tenant_policy_binding_isolation_policy ON tenant_policy_binding;
  CREATE POLICY tenant_policy_binding_isolation_policy ON tenant_policy_binding
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

  DROP POLICY IF EXISTS decision_envelope_isolation_policy ON decision_envelope;
  CREATE POLICY decision_envelope_isolation_policy ON decision_envelope
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

  DROP POLICY IF EXISTS evidence_package_isolation_policy ON evidence_package;
  CREATE POLICY evidence_package_isolation_policy ON evidence_package
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

  DROP POLICY IF EXISTS rights_request_isolation_policy ON rights_request;
  CREATE POLICY rights_request_isolation_policy ON rights_request
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
END $$;
