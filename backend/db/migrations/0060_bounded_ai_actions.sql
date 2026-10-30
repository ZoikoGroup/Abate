-- backend/db/migrations/0060_bounded_ai_actions.sql
-- Playbook B6 (Domains S08 Bounded AI and S09 Action Execution)

-- 1. AI Use-Case Registry (Domain S08)
CREATE TABLE IF NOT EXISTS ai_use_case (
  key text NOT NULL,
  version int NOT NULL,
  purpose text NOT NULL,
  allowed_inputs jsonb NOT NULL, -- e.g. ['RELEASE','APPROVED_KNOWLEDGE']
  output_schema_ref text NOT NULL,
  prompt_version text NOT NULL,
  model_ref text NOT NULL,
  provider_region text NOT NULL,
  max_steps int NOT NULL DEFAULT 1,
  max_input_tokens int NOT NULL DEFAULT 2048,
  max_output_tokens int NOT NULL DEFAULT 1024,
  timeout_ms int NOT NULL DEFAULT 10000,
  monthly_budget_minor bigint NOT NULL DEFAULT 100000, -- e.g. 1000.00 in minor units
  enabled boolean NOT NULL DEFAULT false, -- off until evaluated
  eval_thresholds jsonb NOT NULL, -- usefulness, groundedness, numeric fidelity, safety
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version)
);

-- 2. AI Runs (Audit trail of proposals and validator reports, tenant-isolated)
CREATE TABLE IF NOT EXISTS ai_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  use_case_key text NOT NULL,
  use_case_version int NOT NULL,
  actor_id text NOT NULL,
  context_refs jsonb NOT NULL, -- ids of releases/knowledge, NOT their raw content
  output jsonb, -- validated proposal output only
  status text NOT NULL CHECK (status IN ('PROPOSED','REJECTED_BY_VALIDATOR','ACCEPTED','DISCARDED','FAILED')),
  validator_report jsonb,
  model_ref text NOT NULL,
  prompt_version text NOT NULL,
  tokens_in int,
  tokens_out int,
  cost_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_run_tenant ON ai_run(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_run_use_case ON ai_run(use_case_key, use_case_version);

ALTER TABLE ai_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_run' AND policyname = 'ai_run_tenant_isolation') THEN
    CREATE POLICY ai_run_tenant_isolation ON ai_run
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- 3. AI Kill Switches (Multi-level kill switches)
CREATE TABLE IF NOT EXISTS ai_kill_switch (
  scope text PRIMARY KEY, -- 'use_case:<key>', 'model:<ref>', 'provider:<name>', 'tool:<name>', 'all_ai'
  active boolean NOT NULL DEFAULT false,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Tool Catalog (Domain S09 Safe Action Execution)
CREATE TABLE IF NOT EXISTS tool_catalog (
  tool text PRIMARY KEY,
  schema_ref text NOT NULL,
  enabled boolean NOT NULL DEFAULT false
);

-- 5. Action Attempt (Attempts with leasing, fencing, and ambiguous outcome tracking)
CREATE TABLE IF NOT EXISTS action_attempt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  tool text NOT NULL,
  target text NOT NULL,
  param_hash text NOT NULL,
  resource_version int NOT NULL,
  approval_ref uuid,
  effect_key text NOT NULL, -- stable key reused for retries and provider idempotency
  state text NOT NULL CHECK (state IN ('PENDING','LEASED','DISPATCHED','SUCCEEDED','FAILED','UNKNOWN_OUTCOME','BLOCKED')),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  provider_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, effect_key)
);

CREATE INDEX IF NOT EXISTS idx_action_attempt_tenant ON action_attempt(tenant_id, created_at DESC);

ALTER TABLE action_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_attempt FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'action_attempt' AND policyname = 'action_attempt_tenant_isolation') THEN
    CREATE POLICY action_attempt_tenant_isolation ON action_attempt
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

