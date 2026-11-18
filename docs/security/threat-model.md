# Zoiko Abate Threat Model (Trust-Boundary Register)

> **Reference**: Zoiko Abate Completion Plan Section 9 (`ZAB-ENG-001 v1.0`)
> **Status**: Engineering baseline ready for Security Owner review (`open-signoffs.md`).

---

## 1. Browser <-> API Boundary
- **Threats**: Token theft via `localStorage`, CSRF on cookie-authenticated mutations, XSS, cross-tenant ID enumeration, client-side permission bypass.
- **Controls**:
  - Production/hardened mode authenticates via OIDC PKCE + `HttpOnly; SameSite=Lax; Secure` `abate_session` cookie (`backend/src/platform/oidc.ts`, `backend/src/index.ts`).
  - Cross-origin state mutations are refused when `Origin !== CLIENT_URL` in hardened environments.
  - Foreign tenant IDs and missing IDs return identical `404 NOT_FOUND` (`backend/src/domains/tenant/auth.ts`).
  - Security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on `/api/v2/*`).
- **Verification**: `tests/e2e/pilot-oidc.spec.ts`, `backend/tools/endpoint-check.ts`, `backend/tools/run-independent-challenge.ts` (`CHAL-1.1`).

## 2. API <-> PostgreSQL Boundary
- **Threats**: Pooled connection tenant leakage, missing tenant context, SQL injection, web role reading protected contributor counts (`metric_snapshot`, `disclosure_ledger`, `identity_map`), mutating append-only audit logs.
- **Controls**:
  - `withTenant` sets transaction-local `app.tenant_id` (`set_config(..., true)`), `statement_timeout`, and `lock_timeout` (`backend/src/platform/db/with-tenant.ts`).
  - Every table with `tenant_id` has `ENABLE` + `FORCE ROW LEVEL SECURITY` failing closed when `app.tenant_id` is unset (`docs/db-audit.sql`).
  - Separate pools and least-privilege roles (`abate_app`, `abate_worker`, `abate_identity`, `abate_protected_compute`, `abate_release_compiler`, `abate_performance`, `abate_ops`). `abate_app` has zero grants on `metric_snapshot`, `disclosure_ledger`, and `identity_map`.
  - Append-only triggers (`audit_event_immutable`, `metric_definition_immutable_guard`, `work_fact_purge_guard`).
- **Verification**: `backend/tools/db-audit.ts`, `backend/tools/test-pg-parity.ts`, `backend/tools/verify-pg-clean.ts`.

## 3. Worker <-> Queue / Database Boundary
- **Threats**: Cross-tenant worker reading business facts or identity maps, duplicate event processing, poison-pill starvation.
- **Controls**:
  - `abate_worker` only reads `outbox_event` / `dead_letter_event` and writes `inbox_event` / retry metadata (`0062_outbox_worker_role.sql`, `0080_worker_daemon.sql`).
  - `FOR UPDATE SKIP LOCKED` with lease expiry, exponential backoff, dead-lettering after 5 attempts storing references only (never payloads).
- **Verification**: `backend/tools/test-worker-crash-lab.ts`, `backend/tools/test-pg-parity.ts`.

## 4. Ingestion & Connector Webhook Boundary
- **Threats**: Surveillance decoy fields (`keystroke_tracker`, `screenshots`, `sick_reason`, `billingRate`), forged or replayed connector webhooks, SSRF, connection resurrection after disconnect.
- **Controls**:
  - Strict Zod `.strict()` schemas per connector (`zoikotime.v1.ts`, `calendar-cadence.v1.ts`) — unknown fields fail closed with `400` and zero persistence/logging.
  - HMAC-SHA256 webhook signature (`X-Abate-Signature`), timestamp window (`±300s`), and replay cache (`backend/src/domains/ingest/webhook-auth.ts`).
  - Per-tenant/per-actor rate limiting with stricter ingestion/export/AI buckets (`backend/src/platform/rate-limit.ts`).
- **Verification**: `backend/tools/test-phase2-ingestion.ts`, `backend/tools/test-completion-gates.ts`, `CHAL-3.1`.

## 5. Privacy Compiler & Object Store Boundary
- **Threats**: Small-cohort (`n < 10`), overlap (`symDiff < 5`), or residual (`< 5`) differencing attacks; concurrent race releasing conflicting cohorts; evidence tampering; deletion resurrection after restore.
- **Controls**:
  - Tenant-wide `pg_advisory_xact_lock` serializing release decisions (`compile-release.ts`).
  - `released_artifact` omits `contributor_count` by schema; `UNAVAILABLE` returns uniform non-disclosing payload.
  - Content-addressed SHA-256 verification (`putVerified` / `readVerified`) + external tombstone log (`tombstones/<tenantId>/<runId>.json`).
- **Verification**: `backend/tools/test-reconstruction.ts`, `backend/tools/verify-evidence.ts`, `backend/tools/reconcile-after-restore.ts`.

## 6. Bounded AI & Action Execution Boundary
- **Threats**: Prompt injection, individual-level inference, fabricated citations/numbers, monthly budget exhaustion/race, mutated action grant parameters, Plane B closing Plane A hazards.
- **Controls**:
  - Pre-model screening (`assertNotProhibitedRequest`), schema/citation/numeric/control validators, advisory-locked monthly spend (`lockBudget`), signed HMAC action grants bound to parameter hash + fencing token, `assert_plane_a()` trigger.
- **Verification**: `backend/tools/test-phase6-ai.ts`, `backend/tools/test-phase7-planes.ts`, `CHAL-4.1`, `CHAL-5.1`.

## 7. Support / Operations Boundary
- **Threats**: Support operator impersonating a tenant user or reading tenant business rows; telemetry/logs leaking request bodies or decoy strings.
- **Controls**:
  - Separate `SUPPORT_AUTH_SECRET` and audience (`SUPPORT_AUDIENCE`); support tokens rejected on tenant routes and tenant tokens rejected on ops routes.
  - Allow-list telemetry scrubbing (`TELEMETRY_ALLOWLIST_KEYS`) and error fingerprinting (`telemetry.ts`).
- **Verification**: `backend/tools/test-fast.ts`, `backend/tools/test-completion-gates.ts`, `CHAL-1.1`.
