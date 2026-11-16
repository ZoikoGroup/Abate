# Zoiko Abate — Complete Step-by-Step System Explanation & End-to-End Guide (Start to Finish)

**Last Updated**: 2026-11-16  
**Companion References**:
- Frontend Architecture & Component Guide: [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md)
- Backend API, Database & Domain Guide: [BACKEND_GUIDE.md](./BACKEND_GUIDE.md)
- Architecture Decision Records: [docs/architecture/](./docs/architecture/) and [adr/](./adr/)
- Governance & Open Sign-Offs: [docs/governance/be-spec-reconciliation.md](./docs/governance/be-spec-reconciliation.md) & [docs/governance/open-signoffs.md](./docs/governance/open-signoffs.md)

---

## Quick Mental Model: What Is Zoiko Abate?
Zoiko Abate is a **non-surveillance workplace psychosocial-risk and work-design governance platform** built on one non-negotiable engineering principle:

> **"Change the work. Not the worker."**

Instead of scoring employees or tracking screenshots/keystrokes, Abate:
1. Collects strictly minimized time/cadence intervals under **Strict Schema Rejection (`.strict()`)**.
2. Enforces **Multi-Tenant Isolation inside PostgreSQL itself (`FORCE ROW LEVEL SECURITY`)**.
3. Computes cohort indicators **only** when cohort privacy thresholds pass (`n >= 10` contributors, `>= 28` days, residual `>= 5`, overlap `>= 5`).
4. Drives hazard controls, legal holds, GDPR erasure tombstones, bounded AI proposals, Plane A vs Plane B separation, SRA-aligned UK legal fatigue checks, and cryptographically bound Release Evidence Dossiers.

---

## Part 1: Step-by-Step Architecture & Build Journey (Step 0 to Today)

Below is how the entire platform works in chronological engineering order—showing **Backend + Database + Frontend** side-by-side at every step.

### Step 0: Foundation, Runtime Safety & Constitutional Boundaries (Phase 0)
- **What it does**: Prevents the platform from starting unsafely or leaking secrets/configuration, and documents the non-negotiable non-surveillance rules.
- **Database (`backend/db/init/01-roles.sql`, `0001_roles.sql`)**: Creates three segregated PostgreSQL roles:
  1. `abate_migrator`: Owns DDL schema changes only.
  2. `abate_app`: Restricted app role (`NOSUPERUSER NOBYPASSRLS`) governed by Forced RLS.
  3. `abate_worker`: Background outbox drainer with zero access to pseudonyms (`identity_map`) or privacy tables.
- **Backend (`backend/src/platform/config.ts`, `errors.ts`, `telemetry.ts`)**:
  - `validateRuntimeConfig()` fails closed on startup if `APP_ENV` is `staging` or `production` and any default secret, short key (`< 32` chars), shared secret across `AUTH_SECRET` / `SUPPORT_AUTH_SECRET` / `ACTION_GRANT_SECRET`, `ABATE_REQUIRE_PG !== "1"`, `OBJECT_STORE_MODE !== "s3"`, or `FIXED_CLOCK` is set.
  - Errors convert safely via `AppError` and log opaque fingerprints instead of stack traces or sensitive values.
- **Frontend (`frontend/src/components/Tabs/ConstitutionalTab.tsx`, `index.css`)**:
  - Calls `GET /api/health` and `GET /api/info` on startup and renders the constitutional rules matrix and active system status badge in the top navbar.

---

### Step 1: Multi-Tenant Identity, Atomic Commands & Forced RLS (Phase 1)
- **What it does**: Proves that Tenant A (`Apex Legal Partners`) and Tenant B (`Beacon Chambers`) can never read or mutate each other's rows, and every write is atomic, idempotent, audited, and queued reliably.
- **Backend & Database (`0010_foundation.sql`, `0011_reliability.sql`, `with-tenant.ts`, `command.ts`, `tenant/`)**:
  1. `POST /api/v2/auth/token` (dev/test token issuer) signs a tenant-scoped JWT binding `tenantId`, `subject`, and `role`.
  2. `withTenant(tenantId, fn)` opens a PostgreSQL transaction and runs `SELECT set_config('app.tenant_id', $1, true)` before any SQL query executes.
  3. `runCommand()` executes inside that transaction:
     - Checks `idempotency_record` by `(tenant_id, operation, idempotency_key)`:
       - Same key + same SHA-256 request hash -> returns cached HTTP `200` (zero duplicate rows).
       - Same key + altered body hash -> rejects with HTTP `409 CONFLICT`.
       - Missing `Idempotency-Key` header -> rejects with HTTP `400 VALIDATION`.
     - Inserts domain data (`organization`), writes an immutable `audit_event` (`REVOKE UPDATE, DELETE ON audit_event FROM abate_app`), and writes an `outbox_event` atomically in the same SQL commit.
- **Frontend (`App.tsx`, `Navbar.tsx`, `OrganizationsTab.tsx`, `IsolationTab.tsx`, `OutboxTab.tsx`, `AuditTab.tsx`)**:
  - Top bar **Active Tenant Scope** dropdown requests a new scoped token and reloads `/api/v2/organizations` and `/api/v2/audit-events`.
  - **Organizations & Idempotency** tab has 1-click buttons for **Create**, **Replay Exact Same Request** (`200`), **Tamper Payload with Same Key** (`409`), and **Inject Prohibited Field** (`keystroke_tracker_payload` -> `400`).
  - **Tenant Isolation & Attack Lab** attempts a cross-tenant read on the foreign tenant's seeded org ID and confirms HTTP `404` fail-closed defense.

---

### Step 2: Strict Data Ingestion, Pseudonyms & Worker Daemon (Phase 2 & Outbox Worker)
- **What it does**: Ingests temporal work and calendar intervals while strictly rejecting surveillance data before persistence or logging.
- **Backend & Database (`0020_ingest_ledger.sql`, `0080_worker_daemon.sql`, `0081_phase2_identity_map.sql`, `contracts/sources/`, `domains/ingest/`, `worker/daemon.ts`)**:
  - Two allowlisted `.strict()` connectors:
    1. `ZoikoTime` (`POST /api/v2/connectors/zoikotime/batches`): Accepts `WORK` intervals (`recordId`, `revision`, `subjectRef`, `startUtc`, `endUtc`, `workTz`).
    2. `CalendarCadence` (`POST /api/v2/connectors/calendar-cadence/batches`): Accepts `MEETING_BLOCK`, `FOCUS_BLOCK`, `AFTER_HOURS_CALL` metadata **only** — strictly rejects meeting titles, attendees, locations, URLs, or descriptions.
  - Decoy fields (`screenshotUrl`, `sickReason`, `keystrokeTracker`, `attendees`, `eventTitle`) fail validation with zero persistence across `work_fact_revision`, `audit_event`, `outbox_event`, `ingest_receipt`, `idempotency_record`, or process logs (`test-minimization`).
  - Subject identifiers map to HMAC pseudonyms stored in `identity_map` (explicitly revoked from `abate_worker`).
  - Connection lifecycle tracks `ACTIVE` -> `PAUSED` -> `REVOKED` (terminal), rejecting ingestion on non-ACTIVE connectors (`403`), and computes freshness (`FRESH`, `DELAYED`, `STALE`, `NEVER_SYNCED`).
  - Outbox worker daemon (`src/worker/daemon.ts`) drains `outbox_event` using `SELECT ... FOR UPDATE SKIP LOCKED`, deduplicates via `inbox_event`, and records reference-only rows in `dead_letter_event` on repeated failure.
- **Frontend (`IngestionTab.tsx`)**:
  - Lets presenters inspect approved contracts, register `ZoikoTime` or `CalendarCadence` connections, toggle `Pause`/`Resume`/`Revoke`, send clean batches, and trigger surveillance decoys live.

---

### Step 3: Cohort Measurement & Privacy Release Compiler (Phase 3)
- **What it does**: Turns raw `WORK` intervals into aggregate organizational indicators (`BOUNDARY_INTRUSION_SHARE`) without enabling individual identification.
- **Backend & Database (`0030_metrics.sql`, `0082_phase3_privacy_roles.sql`, `domains/measure/`, `domains/privacy/compile-release.ts`)**:
  - Acquires tenant-level PostgreSQL advisory lock `pg_advisory_xact_lock(hashtextextended('disclosure:' || tenantId, 0))` to serialize concurrent queries.
  - Filters work facts strictly with `AND kind = 'WORK'` (both SQL and `MemoryClient`), ensuring `CalendarCadence` `MEETING_BLOCK` / `AFTER_HOURS_CALL` records never double-count or inflate work metrics.
  - Uses interval union arithmetic so overlapping intervals for a contributor aren't double-counted.
  - Enforces **4 mathematical privacy gates (`DEFAULT_PRIVACY_PROFILE`)**:
    1. Contributor floor `>= 10` (if `n = 9`, returns `status: "UNAVAILABLE"`, `code: "NOT_AVAILABLE"`, zero `releaseId`, zero contributor counts).
    2. Minimum `28`-day window for `CLASS_B` releases.
    3. Cross-request symmetric difference `>= 5` (blocks differencing overlap attacks).
    4. Parent/child residual difference `>= 5` (blocks team subtraction attacks).
  - *Note*: Current release compiler uses deterministic suppression gates (no Laplace noise; `"differential privacy"` phrasing removed under Stage A + `ADR-002`, awaiting Privacy Owner confirmation in Stage B).
  - `abate_worker` is explicitly revoked (`REVOKE ALL`) from reading `metric_snapshot`, `privacy_decision`, `privacy_release`, `released_artifact`, and `disclosure_ledger`.
- **Frontend (`CohortAnalyticsTab.tsx`)**:
  - Provides 1-click **1. Test n = 9 Floor Violation** (`UNAVAILABLE`) and **2. Test n = 10 Valid Release** (`RELEASED`), plus CSV export (`/api/v2/releases/:id/export.csv`) using the same privacy-filtered Single Read Path.

---

### Step 4: Psychosocial Hazard Register & 14-State Control Governance (Phase 4)
- **What it does**: Converts verified cohort indicators into accountable organizational work-design changes (never individual employee targeting).
- **Backend & Database (`0040_risk_control.sql`, `contracts/control.ts`, `domains/control/`)**:
  - Hierarchy: `Privacy Release` -> `Hazard` (`OPEN`, `CONTROLLED`, `DEFERRED`, `ACCEPTED`, `VERIFIED_CLOSURE`) -> `Cause` (`PROPOSED`, `REVIEWED_ACCEPTED`, `REVIEWED_REJECTED`) -> `Intervention Control` (14-state machine: `DRAFT` -> `PROPOSED` -> ... -> `APPROVAL_REQUIRED` -> `APPROVED` -> `IMPLEMENTING` -> `IMPLEMENTED` -> `VERIFYING` -> `CLOSED` / `REOPENED` / `CANCELLED` / `SUPERSEDED`).
  - **Version-Bound Approvals**: Editing a control recomputes `material_hash` and increments `version`, automatically invalidating any prior approval and resetting the state to `APPROVAL_REQUIRED`.
  - **Verification & Risk Transfer**: Evaluates post-control outcomes (`EFFECTIVE`, `PARTIALLY_EFFECTIVE`, `NOT_EFFECTIVE`, `INCONCLUSIVE`) and flags adjacent-cohort deterioration as `TRANSFER_OF_RISK`.
  - Exports verifiable SHA-256 JSON evidence packages (`POST /api/v2/hazards/:id/evidence-package`).
- **Frontend (`HazardControlTab.tsx`, `AiPanel.tsx`, `AuditVerifierTab.tsx`)**:
  - Walks through registering a hazard against the baseline release, proposing/reviewing causes, creating/editing/approving a control, recording implementation evidence, and issuing evidence packages verifiable in **Audit Verifier & Merkle**.

---

### Step 5: Jurisdiction Policy Packs, Retention, Legal Holds & GDPR Erasure (Phase 5)
- **What it does**: Governs legal policy coverage, retention lifetimes, litigation holds, and permanent data erasure without backup resurrection.
- **Backend & Database (`0050_retention_jurisdiction.sql`, `0051_governance_evidence.sql`, `0063_corrections.sql`, `0064_single_pack_catalog.sql`, `contracts/retention.ts`, `domains/lifecycle/`)**:
  - Immutable versioned `policy_pack` catalog (`JURISDICTION`, `SECTOR`, `CUSTOMER`) resolved strictly by effective dates (`fail closed` outside coverage windows).
  - Strict schema (`PublishPackInput.content.strict()` — zero `.passthrough()`) validates optional metadata and `RetentionBounds` (`floor` / `ceiling` days on `WORK_FACT`). Currently seeded synthetic defaults use `90` / `730` days pending Stage B owner sign-off.
  - **Legal Holds**: Active holds block deletion (`eligible = purged + held`) until explicitly released (double release -> `409 CONFLICT`).
  - **Cryptographic Tombstones & Anti-Resurrection**: Erasure/retention writes hash-only `deletion_tombstone` records (zero subject pseudonyms or source IDs). PostgreSQL trigger `work_fact_purge_guard` refuses any direct `DELETE` on `work_fact_revision` without a tombstone or under legal hold, and re-ingested purged records count as `DUPLICATE` instead of resurrecting.
  - Data corrections mark overlapping releases `STALE` and supersede affected evidence packages.
- **Frontend (`RetentionTab.tsx`, `CorrectionBanner.tsx`)**:
  - Displays covered vs expired pack status, retention bounds configuration, preview/purge execution, legal hold creation/release, and replay anti-resurrection demos.

---

### Step 6: Proposal-Only Bounded AI, Ephemeral Action Grants & Kill Switches (Phase 6)
- **What it does**: Adds optional AI explanation and drafting capabilities that **cannot mutate authoritative records** and can be disabled instantly without breaking manual workflows.
- **Backend & Database (`0060_bounded_ai_actions.sql`, `0061_phase6_hardening.sql`, `domains/ai/`, `domains/actions/`)**:
  - Use cases (`explain_release`, `draft_cause`, `draft_control`) pass through strict post-generation validators verifying schema conformance, real citations (blocking hallucinations), numeric fidelity, and prohibited individual-inference blocking.
  - AI runs remain `PROPOSED` until an authorized human clicks **Accept** (`POST /api/v2/ai/runs/:id/accept`), which still writes only `PROPOSED` cause/control drafts requiring human review.
  - **Ephemeral Action Dispatch**: External side effects (`ticket_notification`, `calendar_window`) require an active Phase 4 approval, a short-lived HMAC-signed single-attempt Action Grant bound to exact parameter hashes (`ACTION_GRANT_SECRET`), and lease fencing tokens (`UNKNOWN_OUTCOME` recorded cleanly on provider timeouts).
  - **6 Emergency Kill Switches**: Independently disable `all_ai`, `release_path`, `connector:zoikotime`, `connector:calendar_cadence`, `pack:legal-uk-sra`, and `tool:ticket_notification`.
- **Frontend (`BoundedAiTab.tsx`, `AiPanel.tsx`)**:
  - Triggers AI explanations, demonstrates kill switches shutting off AI while leaving manual controls working, and tests grant mismatch protection.

---

### Step 7: Plane A / Plane B Separation & AI Work-Design Outcomes (Phase 7)
- **What it does**: Prevents employers from closing workplace safety hazards simply because commercial productivity metrics improved, and governs organizational AI rollouts across an 8-stage workflow.
- **Backend & Database (`0070_outcomes_ai_change.sql`, `domains/performance/`, `domains/aichange/`)**:
  - `OutcomeClassEnum` separates `COMPLIANCE_EVIDENCE` (Plane A) from `PERFORMANCE_OUTCOME` (Plane B), locked via PostgreSQL triggers (`assert_outcome_class_immutable`, `assert_plane_a`).
  - Rejects prohibited claims (blame, ranking, disciplinary language) via domain validators.
  - Enforces an 8-stage AI deployment governance lifecycle (`REGISTERED` -> `BASELINE` -> `DETECT` -> `ATTRIBUTE` -> `CONTROL` -> `VERIFY` -> `PERFORMANCE_REVIEW` -> `CLOSED`), blocking closure if open safety obligations remain.
- **Frontend (`OutcomesAiChangeTab.tsx`, `PlaneBadge.tsx`, `PermittedClaims.tsx`)**:
  - Feature-flag gated Plane B workspace visually proving Plane B cannot close Plane A hazards and advancing AI change assessments stage by stage.

---

### Step 8: UK Legal Practice Sector Pack (Domain S13)
- **What it does**: Demonstrates sector-specific workload fatigue risk detection tailored for legal teams without accessing client privilege or billing/ranking data.
- **Backend (`backend/src/domains/sector-legal/index.ts`, routes `/api/v2/sector/legal/*`)**:
  - Maps matter activity intervals neutrally (`WORK_ITEM`) by demand window (`TRIAL_PREP`, `TRIAL`, `CLOSING`, `FILING_DEADLINE`).
  - Strictly rejects privileged legal work product (`substantiveWorkProduct`), `billingRate`, or `individualLawyerRanking`.
  - Runs SRA-aligned fatigue detection alerting on prolonged trial-window surges and enforcing mandatory supervisory partner consultation sign-off. *(Wording updated in Stage A from `"SRA 2023 Compliance"` to `"SRA-aligned"` pending formal legal review.)*
- **Frontend (`LegalPracticeTab.tsx`)**:
  - Interactive legal matter list, **SRA Fatigue Check** button, **Mandatory Supervisory Partner Consultation Gate**, and `#inject-privilege-check` / billing / ranking boundary rejection lab.

---

### Step 9: Operations, Zero-Impersonation Support, Offline Verifier & Release Dossier (Phase 8 & Phase 9)
- **What it does**: Proves support operators cannot impersonate tenants, verifies cryptographic integrity offline in the browser, and compiles all verification runs into a binding Release Evidence Dossier.
- **Backend (`domains/support/`, `platform/merkle.ts`, `tools/build-dossier.ts`, `sign-dossier.ts`, `test-load.ts`, `measure-pg-restore.ts`)**:
  - Support tokens use `SUPPORT_AUTH_SECRET` (mutually rejected against tenant `AUTH_SECRET` routes) and verify HMAC-signed, content-free diagnostic receipts.
  - `AuditVerifierTab.tsx` (Phase 9) verifies JSON manifests, SHA-256 artifact hashes, and binary Merkle roots directly in browser WebCrypto (`window.crypto.subtle`), plus supports uploading any JSON bundle file.
  - `build-dossier.ts` runs 10 verification runners dynamically (`test-boundaries` 57, `test-ingest` 10, `test-privacy` 9, `test-control` 9, `test-retention` 11, `test-ai` 11, `test-planes` 7, `test-worker` 6, `verify-pg` 2, `check:endpoints` 22, plus evidence verifier self-test, 30-day HTTP simulation, restore rehearsal, and 5 kill-switch drills), hashes core evidence + `commitSha` + optional `imageDigests` into `dossierHash`, and outputs `status: "READY FOR REVIEW"`.

---

### Step 10: Stabilization, Security Hardening & Stage B Updates (Completed Work Through Today)
- **Playwright E2E & WCAG 2.1 AA Accessibility Suite (`tests/e2e/*.spec.ts`, `tests/a11y/pages.spec.ts`)**:
  - 7 E2E specs + Axe WCAG 2.1 AA tab/console scans, plus complete offline/CI TypeScript definitions in `tests/declarations.d.ts` and `tests/tsconfig.json` (`0` TypeScript errors).
- **Stage A Security & Accuracy Fixes**:
  - Removed agent-generated `evidence/dossier-signoff.json`; `build-dossier.ts` & `sign-dossier.ts` strictly invalidate stale sign-offs when `dossierHash`, `commitSha`, `imageDigests`, `scope`, or `expiresAt` (`1–90` days) changes.
  - Removed `.passthrough()` from `PublishPackInput.content` (`backend/src/contracts/retention.ts`) -> explicit `.strict()` fields.
  - Fixed `compileRelease` + `MemoryClient` to filter `kind = 'WORK'` so `CalendarCadence` intervals never inflate work metrics (`test-reconstruction.ts` Test 8 verifies this).
  - Removed overclaiming wording (`"differential privacy"`, `"GO"`, `"0 failing P0 tests"`, `"Production API specification"`, `"SRA 2023 Compliance"`) across UI, OpenAPI, E2E specs, and docs.
  - Hardened `backend/Dockerfile` & `frontend/Dockerfile` with immutable SHA-256 base digests, `.dockerignore` files, and non-root Nginx on port `8080`.
  - Extended `verify-pg-seeded-smoke.ts` with direct `withTenant` RLS, `work_fact_revision` purge-guard, and `abate_worker` denial checks.
- **Stage B Governance & Real-Measurement Upgrades**:
  - Reset `ops/slo-manifest.v1.yaml` placeholder approvals (`verified: false`, `"PENDING_MEASURED_EVIDENCE"`).
  - Upgraded `test-load.ts` with `--http` & `--tcp` modes generating `evidence/slo-benchmark-report.json`, and added `measure-pg-restore.ts` (`pg_dump` / `pg_restore` real RTO timing).
  - Authored `docs/architecture/ADR-001`–`005`, `docs/governance/be-spec-reconciliation.md` (logging exact code/spec deltas including `authorize()` vs `APPROVER` and `openapi.ts` vs `index.ts` path drift), and `docs/governance/open-signoffs.md`.
  - Created complete standalone guides: [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) and [BACKEND_GUIDE.md](./BACKEND_GUIDE.md).

---

## Part 2: Complete Live Demo Walkthrough (Step-by-Step Script)

Run Backend (`npm --prefix backend run dev`) + Frontend (`npm --prefix frontend run dev`), or verify via CI/Docker:

1. **Terminal Proof Check (~60 seconds before opening browser)**:
   - Run `npm --prefix backend run test-fast`, `test-minimization`, `test-privacy`, and `build-dossier`.
   - Show the audience: real automated suites confirming zero decoy persistence (`test-minimization`), privacy suppression (`test-privacy`), and `status: READY FOR REVIEW`.
2. **Guided 12-Step Live Demo Console (`http://127.0.0.1:5173/demo`)**:
   - **Step 1 (`GET /api/health`)**: Proves real running Express backend.
   - **Step 2 (`GET /api/v2/contracts/openapi.json`)**: Shows OpenAPI 3.1 contract registry.
   - **Step 3 (`POST /api/v2/auth/token`)**: Shows tenant scope is cryptographically inside the JWT.
   - **Step 4 (`POST /api/v2/organizations`)**: Creates a division + audit + outbox atomically.
   - **Step 5 (`Replay`)**: Exact retry returns `200 OK` without duplicate DB rows.
   - **Step 6 (`409`)**: Same `Idempotency-Key` + mutated payload is blocked with `409 CONFLICT`.
   - **Step 7 (`400`)**: Missing `Idempotency-Key` is blocked with `400 VALIDATION`.
   - **Step 8 (`Tenant B RLS`)**: Tenant B reads `/api/v2/organizations` and sees zero Tenant A rows.
   - **Step 9 (`test-report.json`)**: Loads all `57` boundary gate results.
   - **Step 10 (`GET /api/v2/release/dossier`)**: Shows Release Evidence Dossier (`READY FOR REVIEW`) and opens **Demo Audit Verification Summary**.
   - **Steps 11–12**: Creates & directly fetches a secondary practice division (`Dispute Resolution & Advisory Division`).
3. **Interactive Constitutional Tabs Showcase (`http://127.0.0.1:5173/`)**:
   - **Ingestion & Work Ledger (Phase 2)**: Register a `CalendarCadence` connection, pause/resume it, and fire **Send Surveillance Decoy** -> dropped safely.
   - **Cohort Analytics & Privacy (Phase 3)**: Click **Test n = 9 Floor Violation** (`UNAVAILABLE`) vs **Test n = 10 Valid Release** (`RELEASED`).
   - **Hazards & Controls (Phase 4) -> Retention (Phase 5)**: Register a hazard, edit a control (proving version-bound approval invalidation), place & release a legal hold.
   - **Legal Sector Pack (SRA 2023)**: Run **SRA Fatigue Check**, toggle `#inject-privilege-check` to trigger the rejection firewall, then uncheck for neutral mapping.
   - **Audit Verifier & Merkle**: Issue a live package -> `VERIFIED`, click **Simulate Artifact Tamper** -> immediate `TAMPER OR MISMATCH DETECTED` in WebCrypto.
   - **Operations & Support (B8)**: Issue a diagnostic receipt, sign in as Support Operator, verify zero-impersonation token isolation.

---

## Part 3: What Should Be Done Till the Very Last Step (Remaining Roadmap)

| Stage | Status | Exact Remaining Actions |
| :--- | :--- | :--- |
| **Stage A (Stabilization)** | Ready to Commit | Commit & push working tree to branch `Aditya` (split cleanly into logical PRs) so GitHub CI executes live PostgreSQL `16.2`, Docker image builds, and Playwright + Axe Chromium suites. Install local `tests` deps (`npm --prefix tests install && npm --prefix tests exec -- playwright install chromium`) if running E2E locally. |
| **Stage B (Governance & Real Measurements)** | Tooling & Templates Ready | 1. Run `npm --prefix backend run measure-restore` and `test-load -- --http --tcp` against live PostgreSQL to record real `pg-restore-measurement.json` and `slo-benchmark-report.json` (`POSTGRESQL_LIVE_HTTP`).<br>2. Collect named human approvals in `docs/governance/open-signoffs.md` (Privacy Owner confirmation on suppression vs Laplace, Legal Reviewer approval of SRA-aligned wording, DPO retention durations replacing `90`/`730` placeholders, SRE/Release sign-off on `ops/slo-manifest.v1.yaml`).<br>3. Reconcile `openapi.ts` routes against `src/index.ts` routes (`CR-02`). |
| **Stage C (Independent Challenge)** | Not Started | Have an independent reviewer run adversarial attack drills on live Docker + PostgreSQL (all routes cross-tenant check, `n=9`/`n=10` & race reconstruction, decoys across both connectors, prompt injection, Plane B->A mutation attempts, tampered bundles, restore anti-resurrection) and log P0–P3 findings into `evidence/`. |
| **Stage D (Pilot Readiness — Final Gate Before Customer Data)** | Not Started | 1. Replace dev `POST /api/v2/auth/token` (keep disabled outside `local`/`test`) with real OIDC/SSO JWKS provider validation & clarify `APPROVER` role mapping.<br>2. Move pseudonym HMAC keys, receipt/evidence signing keys, and DB credentials into KMS / Secret Manager with rotation.<br>3. Wire durable S3/GCS artifact storage (`OBJECT_STORE_MODE=s3`), DLQ + latency alerting, and split monolithic `backend/src/index.ts` (~2,503 lines) cleanly.<br>4. Run `npm --prefix backend run sign-dossier` with named human sign-off bound to the final release commit SHA and container image digests. |
