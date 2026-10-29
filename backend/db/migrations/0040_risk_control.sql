-- backend/db/migrations/0040_risk_control.sql
-- Phase 4: Hazard, Control, Approval and Verification Workflow
-- Playbook package B4, Domains S05 (Hazards) and S07 (Interventions)

-- 1. Hazard table: Originating evidence is strictly a RELEASED cohort result
CREATE TABLE IF NOT EXISTS hazard (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  title text NOT NULL,
  owner_principal_id uuid NOT NULL,
  originating_release_id uuid NOT NULL, -- evidence = a RELEASED cohort result, nothing raw
  disposition text NOT NULL DEFAULT 'OPEN' CHECK (disposition IN ('OPEN', 'CONTROLLED', 'DEFERRED', 'ACCEPTED', 'VERIFIED_CLOSURE')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

ALTER TABLE hazard ENABLE ROW LEVEL SECURITY;
ALTER TABLE hazard FORCE ROW LEVEL SECURITY;

CREATE POLICY hazard_tenant_isolation ON hazard
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Cause table: Organizational explanation (never about a person)
CREATE TABLE IF NOT EXISTS cause (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  hazard_id uuid NOT NULL,
  statement text NOT NULL, -- organizational explanation, never about a person
  status text NOT NULL CHECK (status IN ('PROPOSED', 'REVIEWED_ACCEPTED', 'REVIEWED_REJECTED')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, hazard_id) REFERENCES hazard(tenant_id, id)
);

ALTER TABLE cause ENABLE ROW LEVEL SECURITY;
ALTER TABLE cause FORCE ROW LEVEL SECURITY;

CREATE POLICY cause_tenant_isolation ON cause
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Intervention table: Control state machine with material hash
CREATE TABLE IF NOT EXISTS intervention (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  hazard_id uuid NOT NULL,
  cause_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'DRAFT', 'PROPOSED', 'REVIEW_REQUIRED', 'CONSULTATION_REQUIRED', 'APPROVAL_REQUIRED',
    'APPROVED', 'SCHEDULED', 'IMPLEMENTING', 'IMPLEMENTED', 'VERIFYING', 'CLOSED',
    'REOPENED', 'CANCELLED', 'SUPERSEDED'
  )),
  version int NOT NULL DEFAULT 1,
  scope text NOT NULL,
  objective text NOT NULL,
  owner_principal_id uuid NOT NULL,
  due_date date NOT NULL,
  verification_plan jsonb NOT NULL,
  material_hash text NOT NULL, -- hash of the MATERIAL fields only
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, hazard_id) REFERENCES hazard(tenant_id, id)
);

ALTER TABLE intervention ENABLE ROW LEVEL SECURITY;
ALTER TABLE intervention FORCE ROW LEVEL SECURITY;

CREATE POLICY intervention_tenant_isolation ON intervention
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 4. Approval table: Version-bound approvals (the "v4 cannot approve v5" rule)
CREATE TABLE IF NOT EXISTS approval (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  intervention_id uuid NOT NULL,
  approved_version int NOT NULL,
  approved_material_hash text NOT NULL, -- the exact thing approved
  approver_principal_id uuid NOT NULL,
  authority_ref text NOT NULL,
  policy_resolution jsonb NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  approved_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_tenant_isolation ON approval
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 5. Implementation Receipt table: Real and attributable evidence
CREATE TABLE IF NOT EXISTS implementation_receipt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  intervention_id uuid NOT NULL,
  intervention_version int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('MANUAL', 'INTEGRATED')),
  recorded_by uuid NOT NULL,
  completed_on date NOT NULL,
  evidence_refs jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE implementation_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_receipt FORCE ROW LEVEL SECURITY;

CREATE POLICY implementation_receipt_tenant_isolation ON implementation_receipt
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 6. Evaluation table: Plan pinned BEFORE results exist; adverse transfer checks
CREATE TABLE IF NOT EXISTS evaluation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  intervention_id uuid NOT NULL,
  plan jsonb NOT NULL, -- pinned BEFORE results: windows, definition versions, quality floors...
  baseline_release_id uuid,
  post_release_id uuid,
  adjacent_release_ids jsonb NOT NULL DEFAULT '[]',
  series_break boolean NOT NULL DEFAULT false,
  outcome text CHECK (outcome IN ('EFFECTIVE', 'PARTIALLY_EFFECTIVE', 'NOT_EFFECTIVE', 'INCONCLUSIVE')),
  reviewer_id uuid,
  residual_risk text,
  concluded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation FORCE ROW LEVEL SECURITY;

CREATE POLICY evaluation_tenant_isolation ON evaluation
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Indexes for performant lookup
CREATE INDEX IF NOT EXISTS idx_hazard_tenant_release ON hazard(tenant_id, originating_release_id);
CREATE INDEX IF NOT EXISTS idx_cause_tenant_hazard ON cause(tenant_id, hazard_id);
CREATE INDEX IF NOT EXISTS idx_intervention_tenant_hazard ON intervention(tenant_id, hazard_id);
CREATE INDEX IF NOT EXISTS idx_approval_tenant_intervention ON approval(tenant_id, intervention_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_tenant_intervention ON evaluation(tenant_id, intervention_id);

