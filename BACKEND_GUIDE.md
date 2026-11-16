# Zoiko Abate — Backend Guide (`backend/`)

A complete, beginner-friendly guide to understanding, building, running, testing, and demonstrating the **Zoiko Abate** Node.js + Express + TypeScript + PostgreSQL backend, and how every endpoint supports [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md).

---

## 1. Project Overview

### What the Backend Does & Its Role
The `backend/` service is the **constitutional enforcement engine and authoritative data store** for **Zoiko Abate**. Its job is to ensure workplace psychosocial-risk governance operates strictly without individual surveillance:

- **Multi-Tenant Storage Isolation**: Enforces PostgreSQL **Forced Row-Level Security (`FORCE ROW LEVEL SECURITY`)** via `abate_app` (`NOSUPERUSER NOBYPASSRLS`) and `set_config('app.tenant_id', $1, true)` on every transaction (`withTenant`).
- **Two-Plane Non-Contamination**: Isolates **Plane A** (Safety & Hazard Control Governance) from **Plane B** (Commercial Outcomes) via code guards and PostgreSQL triggers.
- **Physical Data Minimization**: Validates every incoming batch against Zod `.strict()` contracts so prohibited surveillance fields (`screenshotUrl`, `keystrokeTracker`, `attendees`, `eventTitle`, `billingRate`, etc.) fail immediately with zero persistence or log trace.
- **Deterministic Cohort Privacy Compiler**: Computes cohort risk metrics (`BOUNDARY_INTRUSION_SHARE`) strictly over `WORK` intervals while enforcing contributor floor (`n >= 10`), Class B window (`>= 28` days), symmetric-difference overlap (`>= 5`), parent/child residual (`>= 5`), and PostgreSQL advisory locks (`pg_advisory_xact_lock`).
- **Transactional Reliability & Cryptographic Evidence**: Executes commands atomically (state + idempotency + append-only audit + outbox) and supports an isolated `abate_worker` outbox daemon (`src/worker/daemon.ts`), SHA-256 + Merkle evidence bundles, retention/legal-hold purge guards, and cryptographically bound Release Evidence Dossiers.

### Tech Stack, Libraries & Versions
Verified directly from `backend/package.json` and `docker-compose.yml`:

| Layer | Technology / Library | Version (in `package.json`) | Purpose |
| :--- | :--- | :--- | :--- |
| Runtime & Language | Node.js `22`, `typescript`, `tsx` | `22.x`, `^5.7.3`, `^4.19.2` | ESM/CJS compilation & fast TS runner for CLI labs/worker |
| Web Framework | `express`, `cors` | `^4.21.2`, `^2.8.5` | HTTP REST API `/api/v2/*`, `/api/health`, `/api/info`, `/docs` |
| Validation Contracts | `zod` | `^3.24.1` | `.strict()` schema parsing & deterministic error formatting |
| Authentication | `jsonwebtoken` | `^9.0.2` | Dev HS256 JWT signing/verification with separate tenant, support & action keys |
| Database Driver | `pg` (against PostgreSQL `16.2-alpine`) | `^8.13.1` | Connection pools (`migrator`, `app`, `worker`), forced RLS transactions + local sandbox `MemoryClient` fallback |
| Environment Config | `dotenv` | `^16.4.7` | Env loading + fail-closed `validateRuntimeConfig` in `staging`/`production` |
| Container | `node:22.14.0-alpine` (pinned SHA-256 digest) | Unprivileged `USER node` | API server (`:5000`) + background `worker` daemon |

---

## 2. Folder Structure

```text
backend/
├── package.json                         # Build, serve, worker, DB migrate, & 20+ verification test runners
├── package-lock.json                    # Locked backend dependency tree
├── tsconfig.json                        # Strict TypeScript compiler config -> outputs to dist/
├── .env.example                         # Variable names & local non-secret defaults template
├── Dockerfile                           # Multi-stage Node 22.14.0-alpine build running as non-root USER node
├── .dockerignore                        # Excludes node_modules, dist, .env*, evidence from image context
├── db/
│   ├── init/01-roles.sql                # Container init script creating abate_migrator, abate_app, abate_worker
│   └── migrations/                      # Numbered SQL migrations (0001_roles through 0082_phase3_privacy_roles)
│       ├── 0001_roles.sql               # Core DB role privileges (migrator vs restricted runtime app)
│       ├── 0010_foundation.sql          # Tenants, principals, organizations, memberships, idempotency, audit, outbox + RLS
│       ├── 0011_reliability.sql         # Reliability & ledger constraints
│       ├── 0020_ingest_ledger.sql       # Source contracts, connections, receipts, work_fact_revision, watermarks
│       ├── 0030_metrics.sql             # Metric definitions, snapshots, privacy_decision, released_artifact, disclosure_ledger
│       ├── 0040_risk_control.sql        # Hazards, causes, interventions, approvals, receipts, evaluations
│       ├── 0050_retention_jurisdiction.sql # Retention classes, legal holds, deletion tombstones + work_fact_purge_guard trigger
│       ├── 0051_governance_evidence.sql # Unified policy_pack catalog, tenant bindings, evidence_package
│       ├── 0060_bounded_ai_actions.sql  # AI use cases, ai_run, kill switches, action attempts & leases
│       ├── 0061_phase6_hardening.sql    # AI & action constraint hardening
│       ├── 0062_outbox_worker_role.sql  # Dedicated abate_worker outbox/inbox RLS permissions
│       ├── 0063_corrections.sql         # Correction events & stale-release invalidation support
│       ├── 0064_single_pack_catalog.sql # Policy pack catalog indexes
│       ├── 0070_outcomes_ai_change.sql  # Plane B outcomes, feature flags, AI change assessments + assert_plane_a trigger
│       ├── 0080_worker_daemon.sql       # Outbox retry/backoff columns & dead_letter_event (references only)
│       ├── 0081_phase2_identity_map.sql # Per-tenant pseudonym identity_map isolated from abate_worker
│       └── 0082_phase3_privacy_roles.sql# Revokes metric_snapshot, privacy_*, disclosure_ledger from abate_worker
├── src/
│   ├── index.ts                         # Express app (~2,503 lines): all HTTP routes, OpenAPI docs, Swagger UI, error middleware
│   ├── contracts/                       # Zod .strict() schemas & OpenAPI specification
│   │   ├── index.ts, common.ts          # Shared error enums & re-exports
│   │   ├── openapi.ts                   # OpenAPI 3.1 registry document
│   │   ├── tenant.ts, ingest.ts         # Organization, token, source adapter schemas
│   │   ├── sources/zoikotime.v1.ts      # ZoikoTime strict work interval schema + IANA timezone validation
│   │   ├── sources/calendar-cadence.v1.ts # CalendarCadence strict metadata schema (rejects titles/attendees/URLs)
│   │   ├── release.ts, control.ts       # Semantic query & Phase 4 hazard/control state enums
│   │   ├── retention.ts, governance.ts  # Policy pack catalog & retention bounds schemas
│   │   └── ai.ts, actions.ts, outcomes.ts, aichange.ts, support.ts # Phases 6, 7, B8 contracts
│   ├── platform/                        # Cross-cutting infrastructure
│   │   ├── config.ts                    # Loads .env & enforces fail-closed validation in staging/production
│   │   ├── db/with-tenant.ts            # PgPool wrappers (withTenant, withWorker) + MemoryClient parity simulator
│   │   ├── command.ts                   # Atomic runCommand pipeline (idempotency + business tx + audit + outbox)
│   │   ├── errors.ts, canonical.ts      # Safe external errors & deterministic request hashing
│   │   ├── merkle.ts, object-store.ts   # Merkle tree proofs + Memory/S3 SigV4 artifact store
│   │   └── slo.ts, telemetry.ts         # P95 percentile calculation & fingerprint-only error logging
│   ├── domains/                         # Business domains isolated by phase/capability
│   │   ├── tenant/                      # auth.ts (JWT + resolveActor + authorize), commands.ts (orgs)
│   │   ├── work/                        # HMAC pseudonym derivation & cryptographic record keys
│   │   ├── ingest/                      # connections.ts, validate.ts, ingest-batch.ts, freshness.ts
│   │   ├── measure/                     # Interval union & BOUNDARY_INTRUSION_SHARE arithmetic
│   │   ├── privacy/                     # compile-release.ts (kind='WORK' + suppression gates), get-release.ts
│   │   ├── control/                     # 14-state machine, materialHash versioning, verification & ZIP/JSON evidence export
│   │   ├── lifecycle/                   # Effective-dated policy packs, legal holds, GDPR erasure, tombstones, corrections
│   │   ├── ai/, actions/                # Proposal-only AI gateway, validators, kill switches, fenced action dispatch grants
│   │   ├── performance/, aichange/      # Plane B outcomes, prohibited claim blockers, 8-stage AI change workflow
│   │   ├── sector-legal/                # Domain S13 UK Legal matter mapping & SRA-aligned fatigue detection
│   │   └── support/                     # Separate support tokens & HMAC-signed content-free diagnostic receipts
│   ├── fixtures/                        # golden01.ts, seed.ts, clock.ts (synthetic tenants A & B fixtures)
│   └── worker/
│       ├── outbox-publisher.ts          # Outbox drain loop + inbox deduplication + DLQ handling
│       └── daemon.ts                    # Background poll loop using abate_worker role + DB ping HTTP/process runner
└── tools/                               # CLI test suites, PG parity checks, SLO & dossier runners
    ├── migrate.ts, bootstrap.ts         # Runs SQL migrations via abate_migrator & initializes local schema
    ├── seed-demo.ts                     # Seeds synthetic Tenant A & B into memory or live PostgreSQL (--pg)
    ├── verify-pg-clean.ts               # Verifies migrations, RLS enforcement & worker denials on clean PG (--require-live)
    ├── verify-pg-seeded-smoke.ts        # Exercises HTTP + direct PG RLS, tombstone guards, & worker denials
    ├── test-fast.ts, test-boundaries.ts # Unit tests (12) + constitutional/isolation gate suite (57)
    ├── test-minimization.ts             # Proves rejected decoy fields leave zero trace in DB, logs, or queues (6)
    ├── test-phase2-ingestion.ts         # Phase 2 ledger, freshness, & CalendarCadence tests (10)
    ├── test-reconstruction.ts           # Phase 3 attack lab: floor n=9/10, residual, overlap, concurrency, calendar WORK guard (9)
    ├── test-phase4-control.ts           # Phase 4 state machine & approval invalidation tests (9)
    ├── test-phase5-retention.ts         # Phase 5 packs, legal holds & anti-resurrection tests (10)
    ├── test-phase6-ai.ts, test-phase7-planes.ts, test-sector-legal.ts, test-worker-crash-lab.ts
    ├── test-slo.ts, test-load.ts        # SLO & 150-req concurrency tests (--http / --tcp -> slo-benchmark-report.json)
    ├── reconcile-after-restore.ts, measure-pg-restore.ts # In-memory rehearsal vs real pg_dump/pg_restore timing
    ├── drill-kill-switches.ts, simulate-30d-http.ts, endpoint-check.ts, verify-evidence.ts
    └── build-dossier.ts, sign-dossier.ts# Executes test runners, hashes commit/artifacts & binds human signoff
```

---

## 3. Order of Work (Build Order)

Understanding or building the backend happens cleanly from the **inside out** (database & perimeter first, business domains second, API & verification tooling on top):

1. **Step 1 — Runtime Config, Errors & Database Role Isolation (`platform/config.ts`, `db/migrations/0001–0011`, `with-tenant.ts`)**
   - *Why first*: Every domain assumes three distinct DB roles (`abate_migrator`, `abate_app`, `abate_worker`), forced RLS, fail-closed staging/prod secrets checking (`validateRuntimeConfig`), and safe error formatting (`AppError`).
2. **Step 2 — Atomic Command Pipeline & Auth (`platform/command.ts`, `domains/tenant/auth.ts`, `commands.ts`)**
   - *Why second*: Every state-changing request flows through `runCommand()` so business writes, idempotency replay/conflict checks, `audit_event`, and `outbox_event` commit in one ACID transaction.
   - *Frontend connection*: Frontend `POST` helpers send `Authorization` and `Idempotency-Key` headers required here (`App.tsx` + `OrganizationsTab.tsx`).
3. **Step 3 — Ingestion & Physical Minimization (`contracts/sources/*.ts`, `domains/ingest/`, `domains/work/`)**
   - *Why third*: Only strictly validated intervals (`ZoikoTime` `WORK` and `CalendarCadence` `MEETING_BLOCK`/`FOCUS_BLOCK`/`AFTER_HOURS_CALL`) with HMAC pseudonyms (`identity_map`) may enter `work_fact_revision`.
   - *Frontend connection*: Powers `IngestionTab.tsx` connection registration, pause/resume, and decoy rejection demos.
4. **Step 4 — Measurement & Privacy Compiler (`domains/measure/`, `domains/privacy/compile-release.ts`)**
   - *Why fourth*: Aggregates stored `kind = 'WORK'` facts only when cohort size `>= 10`, Class B window `>= 28` days, overlap `>= 5`, and parent/child residual `>= 5` under a per-tenant PostgreSQL advisory lock.
   - *Frontend connection*: Powers `CohortAnalyticsTab.tsx` (`n=9` vs `n=10`) and CSV exports.
5. **Step 5 — Governance Domains: Controls, Retention, AI, Plane B, Legal (`domains/control/`, `lifecycle/`, `ai/`, `actions/`, `performance/`, `aichange/`, `sector-legal/`)**
   - *Why fifth*: Each builds on released cohorts and `work_fact_revision` records while enforcing state machines, Plane A vs Plane B isolation triggers, legal holds, tombstone anti-resurrection, and proposal-only AI validators.
   - *Frontend connection*: Each domain maps 1-to-1 with a tab (`HazardControlTab`, `RetentionTab`, `BoundedAiTab`, `OutcomesAiChangeTab`, `LegalPracticeTab`).
6. **Step 6 — Worker Daemon, Support Ops, HTTP Entrypoint & Evidence Dossier (`worker/`, `domains/support/`, `src/index.ts`, `tools/build-dossier.ts`)**
   - *Why last*: Exposes all domain services over Express `/api/v2/*`, drains outbox jobs via least-privilege `abate_worker`, provides zero-impersonation support receipts, and compiles signed cryptographic release dossiers (`evidence/release-dossier.json`).
   - *Frontend connection*: Served directly to Vite (`/api` proxy) and Nginx (`http://backend:5000/api/`), powering `/demo` and `OperationsTab.tsx`.

---

## 4. Detailed Explanation (for Demo)

### Request Security & Persistence Flow
```text
Client Request (Frontend Tab / cURL / Playwright)
  -> Express routes in backend/src/index.ts
  -> authenticate() checks Bearer JWT signature, issuer, & audience (separate secret for support vs tenant)
  -> Zod .strict() schema parses JSON body (unknown/surveillance fields fail immediately with 400 VALIDATION)
  -> Domain command runs inside withTenant(tenantId, tx) -> executes SET LOCAL app.current_tenant_id
  -> PostgreSQL Forced RLS filters all rows by tenant_id + triggers check Plane A/B & tombstone rules
  -> If mutation: runCommand checks idempotency_record -> writes domain row + audit_event + outbox_event atomically
  -> Safe JSON response (no raw stack traces or secret echoes) -> Frontend updates UI
```

### Exposed API Groups (`backend/src/index.ts`)
> Note: OpenAPI 3.1 metadata is served at `GET /api/v2/contracts/openapi.json` and `GET /docs`, though a few route aliases differ between `openapi.ts` and `index.ts` (see `docs/governance/be-spec-reconciliation.md`).

| Feature Group | Implemented Routes (`backend/src/index.ts`) | What Happens Behind the Scenes |
| :--- | :--- | :--- |
| **System & Docs** | `GET /api/health`, `GET /api/info`, `GET /api/v2/contracts/openapi.json`, `GET /docs` | Reports service version, environment, constitutional flags, and API spec without DB tenant context. |
| **Auth & Tenancy** | `POST /api/v2/auth/token`, `/refresh`, `/logout`; `GET /api/v2/me`, `/tenants`, `/tenants/current`, `/tenants/:id`; `GET/POST /api/v2/organizations`, `/organizations/:id`; `GET /api/v2/audit-events`; `POST /api/v2/outbox/drain` | Dev token issuer signs HS256 JWT (`404`/blocked in prod plan). `organizations` runs through `runCommand` (`409 CONFLICT` if same key + changed body). |
| **Ingestion & Connectors** | `POST /api/v2/connectors/zoikotime/batches`, `POST /api/v2/connectors/calendar-cadence/batches`, `GET /api/v2/source-contracts`, `GET/POST /api/v2/connections`, `POST /api/v2/connections/:id/pause\|resume\|revoke`, `GET /api/v2/receipts`, `GET /api/v2/work-facts` | Validates strict intervals, maps subjects to HMAC pseudonyms in `identity_map` (hidden from `abate_worker`), checks connector state (`403` when `PAUSED`/`REVOKED`), tracks freshness (`FRESH`, `DELAYED`, `STALE`, `NEVER_SYNCED`). |
| **Measurement & Privacy** | `GET /api/v2/metrics/definitions`, `POST /api/v2/releases/query`, `GET /api/v2/releases/:id`, `GET /api/v2/releases/:id/export.csv`, `POST /api/v2/metrics/:id/recalculate` | Locks tenant disclosure (`pg_advisory_xact_lock`), sums **only** `kind = 'WORK'` rows (excluding calendar blocks), and suppresses `n < 10` or overlapping/residual `< 5` queries as `UNAVAILABLE`. |
| **Hazards & Controls** | `GET/POST /api/v2/hazards`, `/hazards/:id`, `/hazards/:id/causes`, `/causes/:causeId/review`, `POST/PATCH /api/v2/controls`, `/controls/:id`, `/approve`, `/implementation`, `/verification/pin`, `/verification/conclude`, `/hazards/:id/disposition`, `/hazards/:id/evidence-package` | Enforces 14-state control lifecycle (`ControlStateEnum`), recomputes `material_hash` on control edits to invalidate stale approvals, and bundles SHA-256 manifests. |
| **Retention, Holds & Governance** | `GET /api/v2/jurisdiction/coverage`, `/versions`, `GET /api/v2/retention/state`, `/preview`, `POST /api/v2/retention/classes`, `/run`, `/legal-holds`, `/legal-holds/:id/release`, `POST /api/v2/lifecycle/rights-requests`, `POST /api/v2/corrections/ingest`, `/acknowledge`, `POST/GET /api/v2/evidence-packages`, `/:id`, `/:id/verify`, `GET /api/v2/entitlements`, `/policy/resolution` | Resolves effective-dated `policy_pack` bounds, enforces active legal holds, writes content-free `deletion_tombstone` hashes to prevent backup/re-ingest resurrection, and marks corrected releases `STALE`. |
| **Bounded AI & Actions** | `POST /api/v2/ai/explain-release`, `/draft-cause`, `/draft-control`, `POST /api/v2/ai/runs/:id/accept\|discard`, `GET /api/v2/ai/runs`, `GET/POST /api/v2/actions/proposals`, `/actions/:id/dispatch`, `GET/POST /api/v2/ops/kill-switches`, `GET /api/v2/ai/kill-switches` | Validates AI outputs against grounded citations & numeric fidelity; AI stays `PROPOSED`. External actions require an active Phase 4 approval, ephemeral action grant, and worker lease fencing. |
| **Plane B & Legal Pack** | `GET/POST /api/v2/flags`, `GET/POST/GET:id /api/v2/outcomes/definitions`, `/:id/approve`, `GET/POST/GET:id /api/v2/outcomes/evaluations`, `GET /api/v2/outcomes/releases/:id`, `GET/POST/GET:id /api/v2/ai-changes`, `/:id/advance`, `GET /api/v2/sector/legal/matters`, `POST /api/v2/sector/legal/matters/map`, `/fatigue-check` | Enforces Plane B feature flags + SQL trigger blocking Plane B -> Plane A mutation; tracks 8-stage AI deployment checks; runs Domain S13 SRA-aligned matter fatigue checks & partner consultation gates. |
| **Support, Ops & Dossier** | `POST /api/v2/support/token` *(via support routes)*, `POST /api/v2/support/diagnostic-receipts`, `POST /api/v2/ops/diagnostic-receipts/verify`, `GET /api/v2/ops/errors`, `/release-readiness`, `/connectors`, `/jobs`, `/requests/:requestId`, `GET /api/v2/release/dossier` | Keeps tenant (`AUTH_SECRET`) and support (`SUPPORT_AUTH_SECRET`) tokens mutually rejected; records fingerprint-only error telemetry; serves the release dossier. |

---

## 5. Demo Script

You can showcase the backend **both live with the UI** (`serve`) and via **machine-verified CLI proofs** (estimated **5 minutes**):

### Part A — Constitutional CLI Proof Run (Terminal)
1. Start or point at your terminal in `Abate/`:
   ```bash
   npm --prefix backend run test-fast
   npm --prefix backend run test-minimization
   npm --prefix backend run test-privacy
   ```
   - **Say**: *"Rather than slideware, every privacy and isolation invariant runs as an automated attack suite. `test-minimization` fires surveillance decoys at both ZoikoTime and CalendarCadence connectors and scans logs, tables, and queues to confirm zero traces remain."*
   - **Audience sees**: `12/12` fast invariants, `6/6` decoy minimization checks (`0` traces), and `9/9` reconstruction attack lab checks (including `n=9` block, residual subtraction block, race serialization, and `CalendarCadence` `AFTER_HOURS_CALL` exclusion from `WORK` metrics).
2. Run:
   ```bash
   npm --prefix backend run build-dossier
   ```
   - **Say**: *"Notice the dossier builds dynamically from live test runs, binds to the exact git commit SHA, invalidates stale human sign-offs automatically when code changes, and stays cleanly at `READY FOR REVIEW` until an authorized human executes `sign-dossier`."*
   - **Audience sees**: Dynamic execution across 10 verification runners finishing with `status: READY FOR REVIEW` and a deterministic SHA-256 `Dossier Hash`.

### Part B — Live API Demonstration (with Frontend `/demo`)
3. Run `npm --prefix backend run dev` (alongside `npm --prefix frontend run dev`) and walk through **Steps 1–12** in the UI (`/demo` — see [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) Section 5), pointing out the backend terminal logs showing clean fingerprinted errors without leaking payloads.

### Likely Audience Questions & Short Answers
- **Q: What happens if someone runs the app locally without PostgreSQL installed?**
  - **A**: In `APP_ENV=local` or `test`, `with-tenant.ts` falls back to `MemoryClient` so developers can run labs quickly. Setting `ABATE_REQUIRE_PG=1`—or starting in `staging`/`production`—refuses fallback and exits immediately if PostgreSQL is unreachable.
- **Q: Does `compileRelease` use differential privacy (Laplace noise)?**
  - **A**: Not currently. It uses deterministic cohort suppression (`n >= 10`, 28-day Class B window, overlap `>= 5`, residual `>= 5`, plus advisory lock serialization). See `docs/architecture/ADR-002-privacy-compiler.md` and `docs/governance/open-signoffs.md`.
- **Q: Can the outbox background worker inspect employee work intervals or privacy snapshots?**
  - **A**: No. The daemon connects via `DATABASE_URL_WORKER` (`abate_worker`), which has explicit PostgreSQL `REVOKE ALL` on `identity_map`, `metric_snapshot`, `privacy_decision`, `privacy_release`, `released_artifact`, and `disclosure_ledger` (`0081`/`0082` migrations).

---

## 6. Current Status

### ✅ Done
- **Core Platform & Tenancy**: Atomic `runCommand` pipeline, idempotency replay/conflict guard, forced PostgreSQL RLS, three segregated DB roles, runtime config fail-closed validation (`staging`/`prod`).
- **Ingestion & Connectors**: `ZoikoTime` + `CalendarCadence` `.strict()` connectors, HMAC pseudonymization, freshness engine, decoy zero-trace verification (`test-minimization`), and `kind = 'WORK'` isolation fix in `compileRelease`.
- **Privacy, Controls, Retention, Bounded AI, Plane B & Legal Pack**: All domain engines (`src/domains/*`), SQL triggers (`work_fact_purge_guard`, `assert_plane_a`), worker daemon + DLQ crash lab, and Stage B ADRs (`docs/architecture/ADR-001`–`005`) + BE-001–010 reconciliation (`docs/governance/be-spec-reconciliation.md`).
- **Hardening & Release Gates**: Commit/digest-bound `build-dossier.ts` & `sign-dossier.ts`, pinned non-root Dockerfiles + `.dockerignore`, `--http` / `--tcp` load benchmark runner (`test-load.ts`), and `measure-pg-restore.ts`.

### 🔄 In Progress
- **GitHub CI Live-Postgres + Docker Run**: CI workflow (`.github/workflows/ci.yml`) is wired to run migrations, `verify-pg`, `seed-demo --pg`, `verify-pg-smoke`, `test-load --http --tcp`, Docker image builds, and Playwright E2E once committed/pushed to `Aditya`.
- **Stage B Governance Sign-Offs**: Sign-off templates exist in `docs/governance/open-signoffs.md`, awaiting named human reviewers for privacy mechanism confirmation, SRA-aligned legal wording, and real retention durations.
- **Real Postgres Restore Measurement**: `measure-pg-restore.ts` is ready and tested to fail closed locally; requires a live PostgreSQL instance (`pg_dump`/`pg_restore`) to produce `evidence/pg-restore-measurement.json`.

### ❌ Remaining
- **Stage C Independent Adversarial Challenge**: External review across cross-tenant SQL/API routes, reconstruction races, prompt injection, Plane B/A writes, tamper & restore resurrection on live Postgres + Docker.
- **Stage D Production Pilot Readiness**:
  - Replace local `POST /api/v2/auth/token` dev endpoint (disable completely outside `local`/`test`) with real OIDC/SSO JWKS provider validation & clarify `APPROVER` role mapping (`CR-01` in `be-spec-reconciliation.md`).
  - Reconcile `openapi.ts` documented route paths against live routes in `src/index.ts` (`CR-02`).
  - Connect KMS / Secret Manager for key rotation, durable S3/GCS bucket provisioning, and operational metrics/alerting (worker DLQ & P95 alerts).
  - Execute authentic human dossier ratification (`npm --prefix backend run sign-dossier`) bound to the final release SHA and image digests.

---

## 7. Next Steps

### Prioritized Action List
- **[High] Push Stage A/B Changes & Verify Full CI Pipeline**: Confirm `PostgreSQL Parity, Constitutional Gates & Frontend Build` and `Browser E2E & WCAG 2.1 AA Accessibility` both pass green on GitHub Actions.
- **[High] Run Live-PG Restore & HTTP SLO Measurements**: Execute `npm --prefix backend run measure-restore` and `npm --prefix backend run test-load -- --http --tcp` against PostgreSQL 16.2 to generate real `pg-restore-measurement.json` and `slo-benchmark-report.json`, then have SRE/Release Owners review `ops/slo-manifest.v1.yaml`.
- **[High] Complete Stage B Human Governance Reviews**: Obtain written signatures in `docs/governance/open-signoffs.md` from Privacy Owner, Legal Reviewer, and Retention Owners (replacing `90`/`730` synthetic placeholder bounds).
- **[Medium] Reconcile `openapi.ts` with `src/index.ts` & Modularize `src/index.ts`**: Update OpenAPI route keys (`/connectors/zoikotime/batches`, `/releases/query`, `/work-facts`, `/sector/legal/*`, `/release/dossier`) and split the ~2,503-line `src/index.ts` into domain route modules (`src/routes/*.ts`).
- **[Medium] Execute Stage C Independent Challenge & Stage D OIDC + Secret Management**: Disable `/api/v2/auth/token` in `staging`/`production`, integrate external OIDC JWKS + KMS/S3, and wire production telemetry alerts before any pilot tenant onboarding.
- **[Low] Align Local Docker Compose Credentials & Production Runbooks**: Verify `docker compose --profile fullstack up --build` end-to-end (migrator -> backend -> worker -> frontend).

### Known Limitations & Technical Debt
- Local sandbox testing falls back to `MemoryClient` unless PostgreSQL 16.2 is running (`ABATE_REQUIRE_PG=1` fails closed as designed).
- `backend/src/index.ts` is monolithic (~2,503 lines), and several routes mounted there differ in path name from `backend/src/contracts/openapi.ts`.
- `node-fetch` / loopback TCP sockets in `test-slo.ts` fail with `EACCES` inside restricted Windows sandboxes (`simulate-30d-http.ts` and `test-load.ts --http` use `expressCall` by default unless `--tcp` is passed).

---

## 8. How to Run

### Prerequisites
- Node.js `22`
- *(For live PostgreSQL mode)* PostgreSQL `16.2` (or Docker Desktop running `docker compose up postgres objectstore`) + `pg_dump` / `pg_restore` CLI tools

### Environment Variables (`backend/.env.example` — names only, no secrets)
- **Server**: `PORT`, `NODE_ENV`, `APP_ENV` (`local` | `test` | `staging` | `production`), `CLIENT_URL`
- **Database & Parity Gate**: `ABATE_REQUIRE_PG` (`"1"` forces live PostgreSQL), `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_WORKER`
- **Object Store**: `OBJECT_STORE_MODE` (`memory` | `s3`), `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_BUCKET`, `OBJECT_STORE_REGION`, `OBJECT_STORE_ACCESS_KEY`, `OBJECT_STORE_SECRET_KEY`
- **Authentication & Signing Keys** *(32+ chars, must all be distinct in `staging`/`production`)*: `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_SECRET`, `SUPPORT_AUTH_SECRET`, `ACTION_GRANT_SECRET`
- **Determinism / Releases**: `FIXED_CLOCK` *(allowed only in `local`/`test`; refused in `staging`/`production`)*, `ABATE_IMAGE_DIGESTS` *(optional image digests for dossier binding)*

### Install, Migrate, Run & Test Commands
```bash
# 1. Install dependencies & configure local env
npm --prefix backend ci
cp backend/.env.example backend/.env

# 2. Compile TypeScript (dist/)
npm --prefix backend run build

# 3. (If using live Postgres) Start DB, migrate schema & seed demo fixtures
docker compose up -d postgres objectstore
npm --prefix backend run migrate
npm --prefix backend run verify-pg -- --require-live
npm --prefix backend run seed-demo -- --pg
npm --prefix backend run verify-pg-smoke

# 4. Run API server (:5000) and outbox worker daemon
npm --prefix backend run dev
npm --prefix backend run worker

# 5. Run constitutional test suites & build release dossier
npm --prefix backend run test-fast
npm --prefix backend run test-boundaries
npm --prefix backend run test-minimization
npm --prefix backend run test-ingest
npm --prefix backend run test-privacy
npm --prefix backend run test-control
npm --prefix backend run test-retention
npm --prefix backend run test-ai
npm --prefix backend run test-planes
npm --prefix backend run test-legal
npm --prefix backend run test-worker
npm --prefix backend run test-load:http
npm --prefix backend run build-dossier
```
