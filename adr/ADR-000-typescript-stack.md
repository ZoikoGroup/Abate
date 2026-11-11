================================================================================
ADR-000: TYPESCRIPT / EXPRESS / VITE ARCHITECTURE FOR ZOIKO ABATE
================================================================================

STATUS: ACCEPTED  
OWNER: Architecture Team  
DATE: 2026-10-28 (Updated: 2026-11-11)
FRAMEWORK STANDARD: ZAB-ENG-001 v1.0 & Synthetic-Data Demo Implementation

--------------------------------------------------------------------------------
CONTEXT
--------------------------------------------------------------------------------
Playbook ZAB-ENG-001 originally specified a modular Django monolith. The engineering team elected to implement a unified TypeScript stack to enable end-to-end type safety, shared Zod schemas, and synchronized client contracts without dual writes. The playbook permits stack deviations provided they are formally recorded as architectural decisions and enforce identical isolation, constitutional privacy boundaries, and two-plane non-contamination guarantees.

--------------------------------------------------------------------------------
DECISION
--------------------------------------------------------------------------------
The Zoiko Abate stack is standardized on the following real components:

1. Runtime & Language:
   - Node.js 20+ LTS with TypeScript 5.7+ across backend, frontend, worker, and tooling.
   - Strict compiler configuration (`strict: true`, `noUncheckedIndexedAccess: true`).

2. Backend Service:
   - Framework: Express 4.21 modular monolith with explicit domain boundaries.
   - Structure: `platform`, `domain-tenant`, `domain-ingest`, `domain-work`, `domain-measure`, `domain-privacy`, `domain-control`, `domain-aichange`, `sector-legal`, `contracts`, `fixtures`.

3. Frontend Client:
   - Framework: React 19 Single Page Application (SPA) bundled via Vite.
   - Design System: Custom executive styling using Brand Design Tokens:
     * Aubergine (Hex 2B1B38): Structural authority and headers.
     * Coral (Hex E26D5A): Action items and hazard alerts.
     * Graphite (Hex 2F343A): Body text and neutral borders.
     * Sage Gray (Hex 8D9A96): Secondary metadata.
     * Ivory (Hex F6F4EF): Background canvases.

4. Background Worker:
   - Runtime: Node.js worker daemon executing under restricted role `abate_worker`.
   - Functionality: Transactional outbox event publishing, consumer deduplication via `inbox_event`, dead-letter routing, and async job state tracking.

5. Database & Multi-Tenant Isolation:
   - PostgreSQL 16+ source of truth with forced Row-Level Security (`ENABLE` and `FORCE ROW LEVEL SECURITY`).
   - Transaction-local tenant context: Enforced via `withTenant()` using `SELECT set_config('app.tenant_id', $1, true)`. The `true` parameter guarantees the setting is local to the transaction and never leaks into connection pools.
   - Three distinct database roles:
     * `abate_migrator`: DDL migrations, checksum-tracked via `schema_migrations` and advisory locks.
     * `abate_app`: Restricted runtime application role with `NOSUPERUSER` and `NOBYPASSRLS`.
     * `abate_worker`: Background outbox polling and event publication.

6. Reliability & Audit Invariants:
   - Atomic command pipeline (`runCommand`): Mutating operations write entity state, append-only audit records, and outbox events in a single PostgreSQL transaction.
   - Stripe-Grade Idempotency: All mutating endpoints require `Idempotency-Key`. Replays return cached responses; mutations under identical keys return HTTP 409 Conflict; missing keys return HTTP 400 Bad Request.

--------------------------------------------------------------------------------
RECORDED REAL ENDPOINT PATHS
--------------------------------------------------------------------------------

Authentication & Tenancy:
- POST /api/v2/auth/token: Issues scoped Bearer token.
- POST /api/v2/auth/refresh: Refreshes active Bearer token with identical context.
- POST /api/v2/auth/logout: Terminates session with HTTP 204 No Content.
- GET /api/v2/me: Returns principal profile, tenant, memberships, and allowed navigation.
- GET /api/v2/tenants: Lists accessible tenant workspaces for workspace switching.
- GET /api/v2/tenants/:id: Scoped tenant profile query enforcing strict isolation barriers.
- GET /api/v2/tenants/current: Returns active tenant context.
- POST /api/v2/organizations: Idempotent organizational unit creation.
- GET /api/v2/organizations: Lists scoped organizations within caller's tenant.
- GET /api/v2/organizations/:id: Authoritative organization detail lookup.

Ingestion & Work-State Ledger:
- POST /api/v2/ingestion/batches: Ingests neutral work batches with schema minimization.
- GET /api/v2/ingestion/batches/:id: Looks up batch processing status.
- POST /api/v2/ingestion/batches/:id/seal: Cryptographically seals ingested batch.
- GET /api/v2/ledger/events: Append-only immutable event stream.

Privacy Release & Deterministic Measurement:
- GET /api/v2/privacy/evaluations: Queries privacy compiler release evaluations.
- POST /api/v2/privacy/evaluate: Executes differential privacy and k-anonymity compiler.
- GET /api/v2/metrics/definitions: Canonical metric definitions.
- POST /api/v2/metrics/:id/recalculate: Deterministic recalculation with interval union.

Hazard Control & Mitigation:
- GET /api/v2/hazards: Workplace hazard inventory.
- POST /api/v2/hazards: Registers workplace hazard under strict state machine.
- GET /api/v2/hazards/:id: Hazard record details.
- POST /api/v2/hazards/:id/assessments: Adds risk assessment to hazard.
- POST /api/v2/hazards/:id/controls: Binds versioned mitigation control to hazard.

Domain S13 Sector Legal Pack:
- GET /api/v2/sector/legal/matters: Active legal matters per tenant.
- POST /api/v2/sector/legal/matters/map: Maps matter to neutral work item without surveillance.
- POST /api/v2/sector/legal/fatigue-check: Evaluates SRA-aligned fatigue surge on late-night drafting.

Bounded AI & Dual-Custody Actions:
- POST /api/v2/actions/proposals: Submits bounded action proposal with grant token.
- POST /api/v2/actions/proposals/:id/approve: Dual-custody approval of action proposal.
- GET /api/v2/ai/kill-switches: AI feature kill switch status.

Operations, Diagnostics & Platform Health:
- GET /api/health: Core health status and constitutional boundaries advertisement.
- GET /api/v2/ops/slo: P95 latency and SLO adherence report.
- GET /api/v2/ops/jobs: Background worker queue depth and job status.
- GET /api/v2/jobs/:id: Long-running async job status polling.
- GET /api/v2/ops/connectors: Connector synchronization freshness and lag.
- GET /api/v2/ops/kill-switches: Global emergency kill switches.
- GET /api/v2/release/dossier: Aggregated release evidence dossier.

Contract Registry:
- GET /api/v2/contracts/openapi.json: Authoritative OpenAPI 3.1 specification.
- GET /docs (also /swagger, /api-docs): Interactive Swagger UI explorer.

--------------------------------------------------------------------------------
ACCEPTANCE EVIDENCE
--------------------------------------------------------------------------------
- Fullstack compilation passes with zero errors (`tsc` and `vite build`).
- 8 automated test suites verify 110 cases with 0 failing P0 tests.
- Release dossier status ratified as READY FOR REVIEW.
