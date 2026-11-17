# ADR-003: PostgreSQL Forced Row-Level Security & Least-Privilege Role Boundaries

- **Status**: **DRAFT — Pending Human Review** (agent-authored from codebase inspection; awaiting BE spec holder acceptance)
- **Date**: 2026-11-16
- **Scope**: Database Security (`backend/src/platform/db/with-tenant.ts`, `backend/db/migrations/`)

## Context
Multi-tenant isolation and privacy ledger confidentiality must hold even if application middleware or pooled PostgreSQL connections contain defects, and outbox workers must never access pseudonym mappings or raw privacy snapshots.

## Decision
1. **Three Segregated PostgreSQL Roles**:
   - `abate_migrator`: Owns DDL schema migrations only; never used for request serving.
   - `abate_app`: Subject to `FORCE ROW LEVEL SECURITY` (`NOSUPERUSER NOBYPASSRLS`). Every tenant query runs inside `withTenant(tenantId, fn)`, executing `SELECT set_config('app.tenant_id', $1, true)` before application SQL and reading zero foreign-tenant rows.
   - `abate_worker`: Dedicated to background outbox/dead-letter processing (`withWorker`). Explicitly `REVOKE ALL` on `identity_map` (`0081_phase2_identity_map.sql`) and `metric_snapshot`, `privacy_decision`, `privacy_release`, `released_artifact`, `disclosure_ledger` (`0082_phase3_privacy_roles.sql`).
2. **Storage-Level Guards & Anti-Resurrection**:
   - `work_fact_purge_guard` trigger (`0050_retention_jurisdiction.sql`) rejects direct `DELETE` on `work_fact_revision` without a verified deletion tombstone or under an active legal hold.
   - Purged record digests remain in `deletion_tombstone` so re-delivery counts as `DUPLICATE` rather than resurrecting erased records.
3. **Strict Fail-Closed Guard for Postgres Parity**: When `ABATE_REQUIRE_PG=1` (`migrate`, `verify-pg`, `verify-pg-smoke`), `with-tenant.ts` refuses fallback to `MemoryClient` if PostgreSQL is unreachable.

## Consequences
- Cross-tenant reads and direct SQL updates/deletes are enforced inside PostgreSQL itself (`backend/tools/verify-pg-clean.ts` and `verify-pg-seeded-smoke.ts`), verified in CI against `postgres:16.2-alpine`.
