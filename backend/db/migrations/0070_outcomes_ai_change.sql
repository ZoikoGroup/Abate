-- db/migrations/0070_outcomes_ai_change.sql
-- Zoiko Abate — Phase 7: Work-design outcomes and AI-change assessment
-- Playbook package: B7 (ZAB-ENG-001 v1.0)
-- Enforces separate write authority: Plane B cannot change, close, or downgrade a Plane A obligation.

-- 1. Feature flags table
CREATE TABLE IF NOT EXISTS feature_flag (
  tenant_id uuid,
  flag text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  changed_by text,
  changed_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, flag) -- tenant_id NULL = platform default (all start disabled)
);

-- 2. Outcome definitions table (Four prototype outcome families)
CREATE TABLE IF NOT EXISTS outcome_definition (
  outcome_id text NOT NULL,
  version int NOT NULL,
  outcome_class text NOT NULL CHECK (outcome_class IN ('COMPLIANCE_EVIDENCE', 'PERFORMANCE_OUTCOME')), -- IMMUTABLE
  family text, -- WORKLOAD_SUSTAINABILITY | ROLE_CLARITY | FRAGMENTATION | HUMAN_AI_WORK_QUALITY
  purpose text NOT NULL,
  prohibited_interpretation text NOT NULL,
  unit text NOT NULL,
  definition jsonb NOT NULL,
  quality_rules jsonb NOT NULL,
  privacy_class text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'RETIRED')),
  definition_hash text NOT NULL,
  PRIMARY KEY (outcome_id, version)
);

-- 3. Outcome evaluations table (Plane B)
CREATE TABLE IF NOT EXISTS outcome_evaluation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  outcome_id text NOT NULL,
  outcome_version int NOT NULL,
  intervention_id uuid, -- optional READ-ONLY reference to assurance evidence
  comparison_basis jsonb NOT NULL,
  confounders jsonb NOT NULL,
  series_break boolean NOT NULL DEFAULT false,
  outcome_confidence text NOT NULL,
  permitted_claims jsonb NOT NULL,
  evidence_refs jsonb NOT NULL,
  release_id uuid NOT NULL, -- same privacy compiler: value comes from a Privacy Release
  plane text NOT NULL DEFAULT 'B' CHECK (plane = 'B'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. AI Change Profiles table
CREATE TABLE IF NOT EXISTS ai_change_profile (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  title text NOT NULL,
  version int NOT NULL DEFAULT 1,
  affected_roles jsonb NOT NULL,
  affected_tasks jsonb NOT NULL,
  automation_mode text NOT NULL, -- e.g. ASSIST | AUTOMATE_WITH_REVIEW
  decision_rights text NOT NULL,
  human_override text NOT NULL,
  monitoring_changes text NOT NULL,
  throughput_assumptions text NOT NULL,
  rollout_date date NOT NULL,
  training_support text NOT NULL,
  UNIQUE (tenant_id, id, version)
);

-- 5. AI Work-Design Assessment table
CREATE TABLE IF NOT EXISTS ai_workdesign_assessment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_version int NOT NULL,
  stage text NOT NULL CHECK (stage IN ('REGISTERED', 'BASELINE', 'DETECT', 'ATTRIBUTE', 'CONTROL', 'VERIFY', 'PERFORMANCE_REVIEW', 'CLOSED')),
  hazard_ids jsonb NOT NULL DEFAULT '[]',
  control_ids jsonb NOT NULL DEFAULT '[]',
  baseline_release_ids jsonb NOT NULL DEFAULT '[]',
  verification_refs jsonb NOT NULL DEFAULT '[]',
  version int NOT NULL DEFAULT 1
);

-- 6. Add last_write_plane to hazard and plane to privacy releases
ALTER TABLE hazard ADD COLUMN IF NOT EXISTS last_write_plane text NOT NULL DEFAULT 'A';
ALTER TABLE privacy_release ADD COLUMN IF NOT EXISTS plane text NOT NULL DEFAULT 'A';
ALTER TABLE released_artifact ADD COLUMN IF NOT EXISTS plane text NOT NULL DEFAULT 'A';

-- 7. Database Plane Guard: refuse assurance state changes whose origin plane is not 'A'
CREATE OR REPLACE FUNCTION assert_plane_a() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.write_plane', true) IS DISTINCT FROM 'A' THEN
    RAISE EXCEPTION 'assurance state may only be written by plane A commands';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hazard_plane_guard ON hazard;
CREATE TRIGGER hazard_plane_guard BEFORE UPDATE OF disposition ON hazard
  FOR EACH ROW EXECUTE FUNCTION assert_plane_a();

DROP TRIGGER IF EXISTS intervention_plane_guard ON intervention;
CREATE TRIGGER intervention_plane_guard BEFORE UPDATE OF state ON intervention
  FOR EACH ROW EXECUTE FUNCTION assert_plane_a();

DROP TRIGGER IF EXISTS evaluation_plane_guard ON evaluation;
CREATE TRIGGER evaluation_plane_guard BEFORE UPDATE OF outcome ON evaluation
  FOR EACH ROW EXECUTE FUNCTION assert_plane_a();

-- 8. Immutable outcome_class trigger: block updating outcome_class after approval
CREATE OR REPLACE FUNCTION assert_outcome_class_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'APPROVED' AND NEW.outcome_class IS DISTINCT FROM OLD.outcome_class THEN
    RAISE EXCEPTION 'outcome_class is immutable after approval';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outcome_class_guard ON outcome_definition;
CREATE TRIGGER outcome_class_guard BEFORE UPDATE ON outcome_definition
  FOR EACH ROW EXECUTE FUNCTION assert_outcome_class_immutable();

-- 9. Row-Level Security for new tables
ALTER TABLE feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_change_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_workdesign_assessment ENABLE ROW LEVEL SECURITY;

CREATE POLICY feature_flag_tenant_isolation ON feature_flag
  FOR ALL TO abate_app
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY outcome_definition_read ON outcome_definition
  FOR ALL TO abate_app
  USING (true)
  WITH CHECK (true);

CREATE POLICY outcome_evaluation_tenant_isolation ON outcome_evaluation
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY ai_change_profile_tenant_isolation ON ai_change_profile
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY ai_workdesign_assessment_tenant_isolation ON ai_workdesign_assessment
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

