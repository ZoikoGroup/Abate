-- backend/db/migrations/0093_worker_tenant_state_grant.sql
-- Migration 0092 updated ops_active_tenants (security_invoker = true) to project
-- tenant.state alongside (id, region). Grant narrow column-level SELECT (state)
-- on tenant to abate_worker so background workers can query ops_active_tenants
-- under security_invoker without gaining access to tenant.name or other columns.

GRANT SELECT (state) ON tenant TO abate_worker;
