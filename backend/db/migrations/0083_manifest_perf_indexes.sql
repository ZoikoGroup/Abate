-- backend/db/migrations/0083_manifest_perf_indexes.sql
-- Stage B Item 2 / B8 Manifest Scale Performance Indexes
-- Accelerates privacy release lookup, interval measurement scan over 400k+ facts, and cohort membership resolution.

CREATE INDEX IF NOT EXISTS idx_work_fact_tenant_kind_window
  ON work_fact_revision (tenant_id, kind, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_privacy_decision_tenant_query
  ON privacy_decision (tenant_id, semantic_query_hash);

CREATE INDEX IF NOT EXISTS idx_privacy_release_decision_status
  ON privacy_release (decision_id, status);

CREATE INDEX IF NOT EXISTS idx_effective_membership_tenant_org
  ON effective_membership (tenant_id, organization_id, valid_from, valid_to);
