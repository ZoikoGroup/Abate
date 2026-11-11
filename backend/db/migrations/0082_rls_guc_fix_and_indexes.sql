-- 0082: fix Phase 7 row-level-security policies and add missing hot-path indexes.
--
-- 1. 0070 wrote its policies against current_setting('app.current_tenant_id'), but withTenant()
--    (src/platform/db/with-tenant.ts) sets 'app.tenant_id', which every other migration uses.
--    The setting 'app.current_tenant_id' is never set, so under the abate_app role these tables
--    returned zero rows and rejected every INSERT ("new row violates row-level security policy").
--    Applied migrations are checksum-locked, so the policies are recreated here.
--
-- 2. Indexes for queries issued on every request / list endpoint that had no supporting index.

DROP POLICY IF EXISTS feature_flag_tenant_isolation ON feature_flag;
CREATE POLICY feature_flag_tenant_isolation ON feature_flag
  FOR ALL TO abate_app
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS outcome_evaluation_tenant_isolation ON outcome_evaluation;
CREATE POLICY outcome_evaluation_tenant_isolation ON outcome_evaluation
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS ai_change_profile_tenant_isolation ON ai_change_profile;
CREATE POLICY ai_change_profile_tenant_isolation ON ai_change_profile
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS ai_workdesign_assessment_tenant_isolation ON ai_workdesign_assessment;
CREATE POLICY ai_workdesign_assessment_tenant_isolation ON ai_workdesign_assessment
  FOR ALL TO abate_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- resolveActor() runs on every authenticated request: lookup by tenant + principal, validity window
CREATE INDEX IF NOT EXISTS idx_effective_membership_tenant_principal
  ON effective_membership (tenant_id, principal_id, valid_from);
CREATE INDEX IF NOT EXISTS idx_effective_membership_tenant_org
  ON effective_membership (tenant_id, organization_id);

-- audit trail listing (newest first, per tenant)
CREATE INDEX IF NOT EXISTS idx_audit_event_tenant_time
  ON audit_event (tenant_id, occurred_at DESC);

-- ingest/ledger lists and metric computation read work facts by tenant + time window / pseudonym
CREATE INDEX IF NOT EXISTS idx_work_fact_revision_tenant_start
  ON work_fact_revision (tenant_id, start_at);
CREATE INDEX IF NOT EXISTS idx_work_fact_revision_tenant_subject
  ON work_fact_revision (tenant_id, subject_pseudonym);
CREATE INDEX IF NOT EXISTS idx_ingest_receipt_tenant_received
  ON ingest_receipt (tenant_id, received_at DESC);

-- privacy gate: differencing check scans the disclosure ledger per tenant + metric; decisions are looked up by query hash
CREATE INDEX IF NOT EXISTS idx_disclosure_ledger_tenant_metric
  ON disclosure_ledger (tenant_id, metric_id);
CREATE INDEX IF NOT EXISTS idx_privacy_decision_tenant_query
  ON privacy_decision (tenant_id, semantic_query_hash);

-- outbox listing / counts per tenant
CREATE INDEX IF NOT EXISTS idx_outbox_event_tenant
  ON outbox_event (tenant_id, created_at);
