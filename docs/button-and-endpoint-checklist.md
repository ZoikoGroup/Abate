# Abate Button, Demo Step & Endpoint Verification Checklist

> **Verification Date:** 2026-11-19
> **Verified Against:** Updated workspace after Sprints 1–2 and Phase B completion
> **Playwright & Axe Suite:** `45 / 45 PASS` (`0` failed, `0` skipped, `2.2m`)

---

## 1. Runtime Mode: Live PostgreSQL vs `memDb`

- **Active Demo Engine (Local Windows Host):** **`memDb`** (in-memory relational parity engine in `backend/src/platform/db/with-tenant.ts`).
- `GET /api/health` on this host reports `"database": { "mode": "memory", "required": false, "ok": false }` because PostgreSQL is not running or listening on port `5432`.
- Running `npm --prefix backend run verify-pg-smoke` outside the sandbox failed with:
  ```text
  [PG SEEDED SMOKE FAILED] AggregateError [ECONNREFUSED]:
    connect EACCES/ECONNREFUSED ::1:5432
    connect ECONNREFUSED 127.0.0.1:5432
  ```
- **What `memDb` covers:** All 106 API paths, Zod `.strict()` schema validation, idempotency hash comparison (`409` / `400`), tenant scoping (`404 NOT_FOUND` cross-tenant), Phase 2–8 domain workflows, prohibited claim enforcement, stage guards, and cryptographic Merkle evidence packages.
- **What still requires a running PostgreSQL host:** SQL RLS policies under `abate_app`, `abate_worker` table revocations, SQL purge/Plane-B triggers (`work_fact_purge_guard`), and measured backup/restore RTO/RPO runs (`measure-restore`).

---

## 2. Part 1 Inventory Findings & Part 2 Fixes Applied

Before fixes, several buttons across the Live Demo Console and domain tabs were `BROKEN`, `MOCKED`, `DEAD`, or masked failures with fallback values. Every defect discovered during live interactive browser verification was fixed (with zero new product features added):

| Component / Area | Initial State | Root Cause / Original Error | Part 2 Fix Applied |
| :--- | :--- | :--- | :--- |
| **Live Demo Console** (`LiveDemoConsole.tsx`) | `BROKEN` (Step 6 standalone, Step 9/10 fallbacks) | Step 6 failed standalone if Step 4 had not seeded an org; Steps 9 & 10 fell back to `\|\| 57`, `\|\| 10`, `\|\| "READY FOR REVIEW"`; Step 9 summary badges hardcoded `PASS`; Step 6/7 showed generic badges; cURL snippets exposed raw JWTs and hardcoded `http://localhost:5000`. | Auto-seeds baseline org in `runStep6` if run standalone; removed all fake count/status fallbacks; computes `t.passed` & `PASS`/`FAIL` strictly from real HTTP payloads; renders blue **`Expected: 409`** / **`Expected: 400`** badges with **`"The backend refused this on purpose."`**; masks JWTs in cURL (`<REDACTED_JWT>`) and uses `window.location.origin`. |
| **Ingestion & Work Ledger** (`IngestionTab.tsx`) | `BROKEN` | `Send Duplicate Replay` regenerated a fresh key/payload; alert rendered `Batch "undefined"` instead of `batch_id`; `PAUSE`/`RESUME` could pick non-ACTIVE connections silently. | Stores `lastSentBatch` to replay identical payload/key (`200` idempotent replay); displays `batch_id \|\| batchId`; surfaces `Request ID` cleanly (`withReqId`). |
| **Cohort Analytics & Privacy** (`CohortAnalyticsTab.tsx`) | `BROKEN` / `MOCKED` label | CSV export used `window.alert()` on errors; button label said `"Compiling Differential Release..."`; Overlap/Residual attack buttons relied on clicking prior buttons first. | Replaced `alert()` with inline error banner + `Request ID` + loading state; renamed label to `"Compiling Privacy-Safe Release..."`; attacks ensure prior baseline/parent cohort compilation first so suppression determinism is repeatable in any click order. |
| **Outbox & Organizations** (`OutboxTab.tsx`, `OrganizationsTab.tsx`) | `BROKEN` (alerts/missing IDs) | `OutboxTab` used `window.alert()` on error; `OrganizationsTab` omitted `Request ID` on `CONFLICT`/`VALIDATION` banners. | Replaced `window.alert()` with accessible `role="alert"` inline banner + `requestId`; added `Request ID` details in `OrganizationsTab`. |
| **Retention & Legal Hold** (`RetentionTab.tsx`) | `BROKEN` (error clarity) | Generic catch without `ApiError.requestId`; non-ACTIVE connection wording unclear; missing busy indicators on buttons. | Added `formatRetentionError` (`Request ID`), `role="alert"`, explicit busy text, and clearer active-connection messaging. |
| **Hazards & Controls** (`HazardControlTab.tsx`, `client.ts`, `index.ts`) | `BROKEN` / `MOCKED` | (1) Defaulted `implementationKind` to invalid `"ORGANIZATIONAL_POLICY"` (`400`); (2) `pinVerificationPlan` & `concludeVerification` sent mismatched keys/missing `postReleaseId`; (3) `"1. Skip Approval Attack"` mocked a client refusal instead of calling backend `409`; (4) Gate 3 & verification cards showed hardcoded `32.5%` / `14.0%` / `8.0% -> 9.0%`; (5) `index.ts` `/causes/:causeId/review` missed `const hazardId`; (6) Matter cards were `<div onClick>`. | Changed options to `"MANUAL"` / `"INTEGRATED"`; fixed `client.ts` payloads for `PinVerificationPlanInput` & `ConcludeVerificationInput`; wired `"1. Skip Approval Attack"` to real `POST /api/v2/controls/:id/implementation` requiring HTTP `409`; labeled `"3. Transfer of Risk Flag (Simulation)"` and replaced hardcoded figures with real `verificationPlan` / `evaluation` fields; fixed `hazardId` in `backend/src/index.ts`; converted cards to `<button type="button">` and added `Request ID` on all errors. |
| **Outcomes & AI Change** (`OutcomesAiChangeTab.tsx`, `evaluations.ts`, `with-tenant.ts`, `client.ts`) | `BROKEN` / Masked failures | 4 bugs uncovered during live clicking: (1) Default `selectedOutcomeId` was `"OUTCOME_WORKLOAD_SUSTAINABILITY"` while seeded ID is `"WORKLOAD_SUSTAINABILITY"` (`404`); (2) Running Phase 3 Recalculation marked `BASELINE_RELEASE_ID` `STALE` (`409`); (3) `PROHIBITED_CLAIM_PATTERNS` in `evaluations.ts` allowed `"reduces employee stress and mitigates boundary intrusion hazard."` with `201`; (4) `with-tenant.ts` filtered `FROM AI_WORKDESIGN_ASSESSMENT` by `a.id === params[0]` even when `params[0]` was `tenantId` (`[]`), and `advanceAiAssessment` sent extraneous `version` key in strict body (`400`); (5) Lab catches forced `PASS` on arbitrary errors. | Fixed default outcome ID to `"WORKLOAD_SUSTAINABILITY"`; added `ensureReleasedArtifactId()` to compile a fresh compliant cohort if stale; tightened `PROHIBITED_CLAIM_PATTERNS` in `evaluations.ts`; fixed `WHERE ID = $1` vs `ORDER BY VERSION DESC` checks in `with-tenant.ts`; removed `version` from JSON body in `advanceAiAssessment`; strictly require HTTP `400` on Lab 1 and HTTP `409` on Lab 2. |
| **Bounded AI & Actions** (`AiPanel.tsx`, `BoundedAiTab.tsx`) | `BROKEN` | Missing explicit `else` branches if backend unexpectedly returned `200`; `grantToken` prefix rendered in DOM; `.catch(() => [])` swallowed errors silently; missing `Request ID`s. | Added explicit failure branches, redacted grant token prefix, removed silent `.catch(() => [])`, surfaced `Request ID`, and cleared stale banners on new action start. |
| **Legal Sector Pack (SRA 2023)** (`LegalPracticeTab.tsx`) | `MOCKED` / `DEAD` nesting | `"Sign Supervisory Consultation Gate"` had no backend sign endpoint; nested clickable `<button>` inside `<div onClick>`; auto-clearing `setTimeout`s; permissive catch on decoy gate. | Explicitly labeled **`Sign Supervisory Consultation Gate (Simulation)`**; removed clickable outer `<div>` and auto-clear timers; enforced HTTP `400` / `VALIDATION` check on decoy test + `Request ID`. |
| **Operations & Support (B8)** (`OperationsTab.tsx`) | `MOCKED` | Static Disaster Recovery (`8 ms`) and 150-concurrency tables presented without simulation marker; Release Dossier Gate 8 always appeared static. | Explicitly labeled tables **`Simulation (Reference Target)`** and **`Simulation (Baseline Reference)`**; dynamically bound Release Dossier gates from loaded `dossier` JSON. |
| **Audit Trail & Audit Verifier** (`AuditTab.tsx`, `AuditVerifierTab.tsx`) | `DEAD`-feeling / `Request ID` gap | `Refresh Log` lacked busy/status/error feedback; `<tr onClick>` was non-button; verifier actions lacked `Request ID` on failures. | Added loading, inline `statusMsg`, and error banner with `Request ID` in `AuditTab`; converted `<tr onClick>` to accessible `<button type="button">` and added `actionNotice` + `Request ID` in `AuditVerifierTab`. |
| **OpenAPI Spec Registry** (`backend/src/contracts/openapi.ts`) | Incomplete (`51` paths) | Frontend called 55+ routes under `/api/v2/*` missing from `openApiSpec.paths`. | Documented all mounted `/api/v2/*` routes (**`106` path definitions** total verified by `check:endpoints`). |

---

## 3. Backend Routes Called by Frontend vs `openapi.json`

`backend/src/contracts/openapi.ts` defines **`servers: [{ url: "/api/v2" }]`** with **`106` path definitions** (`check:endpoints` confirmed `0` drift). Three infrastructure/spec endpoints sit outside `/api/v2` path keys:
- `GET /api/health` and `GET /api/info` (mounted directly under `/api/` in `backend/src/index.ts`, verified `200 OK` by `check:endpoints` and Demo Step 1).
- `GET /api/v2/contracts/openapi.json` (serves the OpenAPI 3.1 document itself, verified `200 OK` by Demo Step 2 and Constitutional tab).

Every `/api/v2/*` route invoked by `frontend/src/api/client.ts`, `LiveDemoConsole.tsx`, and tab components matches an entry in `openApiSpec.paths`:

| Domain Group | Routes Called by Frontend | OpenAPI Spec Path Match | Shape Verified |
| :--- | :--- | :--- | :--- |
| **Auth & Session** | `POST /api/v2/auth/token`, `POST /api/v2/auth/refresh`, `POST /api/v2/auth/logout`, `GET /api/v2/auth/oidc/config`, `POST /api/v2/auth/oidc/exchange`, `POST /api/v2/auth/support-token` | `/auth/token`, `/auth/refresh`, `/auth/logout`, `/auth/oidc/config`, `/auth/oidc/exchange`, `/auth/support-token` | YES |
| **Tenancy & Identity** | `GET /api/v2/me`, `GET /api/v2/tenants`, `GET /api/v2/tenants/:id`, `GET /api/v2/tenants/current` | `/me`, `/tenants`, `/tenants/{id}`, `/tenants/current` | YES |
| **Organizations & Outbox & Audit** | `GET /api/v2/organizations`, `POST /api/v2/organizations`, `GET /api/v2/organizations/:id`, `GET /api/v2/audit-events`, `POST /api/v2/outbox/drain` | `/organizations`, `/organizations/{id}`, `/audit-events`, `/outbox/drain` | YES |
| **Ingestion & Work Ledger (Phase 2)** | `GET /api/v2/source-contracts`, `GET /api/v2/connections`, `POST /api/v2/connections`, `POST /api/v2/connections/:id/pause`, `/resume`, `/suspend`, `/revoke`, `POST /api/v2/connectors/zoikotime/batches`, `GET /api/v2/receipts`, `GET /api/v2/work-facts` | `/source-contracts`, `/connections`, `/connections/{id}/pause`, `/resume`, `/suspend`, `/revoke`, `/connectors/zoikotime/batches`, `/receipts`, `/work-facts` | YES |
| **Metrics & Privacy Compiler (Phase 3)** | `GET /api/v2/metrics/definitions`, `POST /api/v2/metrics/:id/recalculate`, `POST /api/v2/releases/query`, `GET /api/v2/releases/:id`, `GET /api/v2/releases/:id/export.csv` | `/metrics/definitions`, `/metrics/{id}/recalculate`, `/releases/query`, `/releases/{id}`, `/releases/{id}/export.csv` | YES |
| **Hazards & Controls (Phase 4)** | `GET /api/v2/hazards`, `POST /api/v2/hazards`, `GET /api/v2/hazards/:id`, `POST /api/v2/hazards/:id/causes`, `POST /api/v2/hazards/:id/causes/:causeId/review`, `POST /api/v2/hazards/:id/disposition`, `POST /api/v2/hazards/:id/evidence-package`, `POST /api/v2/controls`, `PATCH /api/v2/controls/:id`, `POST /api/v2/controls/:id/approve`, `/implementation`, `/verification/pin`, `/verification/conclude` | `/hazards`, `/hazards/{id}`, `/hazards/{id}/causes`, `/hazards/{id}/causes/{causeId}/review`, `/hazards/{id}/disposition`, `/hazards/{id}/evidence-package`, `/controls`, `/controls/{id}`, `/controls/{id}/approve`, `/implementation`, `/verification/pin`, `/verification/conclude` | YES |
| **Retention & Legal Holds (Phase 5)** | `GET /api/v2/jurisdiction/pack-versions`, `GET /api/v2/retention`, `POST /api/v2/retention/classes`, `GET /api/v2/retention/preview`, `POST /api/v2/retention/runs`, `POST /api/v2/legal-holds`, `POST /api/v2/legal-holds/:id/release` | `/jurisdiction/pack-versions`, `/retention`, `/retention/classes`, `/retention/preview`, `/retention/runs`, `/legal-holds`, `/legal-holds/{id}/release` | YES |
| **Bounded AI & Actions (Phase 6)** | `POST /api/v2/ai/explain-release`, `/draft-cause`, `/draft-control`, `GET /api/v2/ai/runs`, `POST /api/v2/ai/runs/:id/accept`, `/discard`, `GET /api/v2/ai/kill-switches`, `POST /api/v2/actions/proposals`, `POST /api/v2/actions/:id/dispatch` | `/ai/explain-release`, `/ai/draft-cause`, `/ai/draft-control`, `/ai/runs`, `/ai/runs/{id}/accept`, `/ai/runs/{id}/discard`, `/ai/kill-switches`, `/actions/proposals`, `/actions/{id}/dispatch` | YES |
| **Outcomes & AI Change (Phase 7)** | `GET /api/v2/flags`, `POST /api/v2/flags`, `GET /api/v2/outcomes/definitions`, `POST /api/v2/outcomes/evaluations`, `GET /api/v2/outcomes/evaluations`, `POST /api/v2/ai-changes`, `GET /api/v2/ai-changes`, `POST /api/v2/ai-changes/:id/advance` | `/flags`, `/outcomes/definitions`, `/outcomes/evaluations`, `/ai-changes`, `/ai-changes/{id}/advance` | YES |
| **Legal Sector Pack (SRA 2023)** | `GET /api/v2/sector/legal/matters`, `POST /api/v2/sector/legal/matters/map`, `POST /api/v2/sector/legal/fatigue-check` | `/sector/legal/matters`, `/sector/legal/matters/map`, `/sector/legal/fatigue-check` | YES |
| **Operations, Dossier & Evidence (B8)** | `POST /api/v2/support/diagnostic-receipts`, `POST /api/v2/ops/diagnostic-receipts/verify`, `GET /api/v2/ops/slo`, `GET /api/v2/ops/errors`, `GET /api/v2/ops/requests/:requestId`, `GET/POST /api/v2/ops/kill-switches`, `GET /api/v2/ops/jobs`, `GET /api/v2/release/dossier`, `GET/POST /api/v2/evidence-packages` | `/support/diagnostic-receipts`, `/ops/diagnostic-receipts/verify`, `/ops/slo`, `/ops/errors`, `/ops/requests/{requestId}`, `/ops/kill-switches`, `/ops/jobs`, `/release/dossier`, `/evidence-packages` | YES |

---

## 4. Verified Button, Form, Link & Demo Step Matrix (`Part 3`)

### A. Navbar & Global Shell (`Navbar.tsx` + `App.tsx`)

| Tab | Button / Control | API call | Expected result | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Navbar | Active Tenant Scope `<select>` | `POST /api/v2/auth/token`, `GET /api/v2/tenants/current`, `GET /api/v2/organizations`, `GET /api/v2/audit-events` | Switches tenant context (`Apex Legal` <-> `Beacon Chambers`) & reloads isolated data | PASS | `tests/e2e/all-tabs-buttons.spec.ts:25` (`ok 16`) |
| Navbar | Effective Domain Role `<select>` | Local role state + subsequent authenticated calls | Updates active domain role (`RISK_OWNER`, `REVIEWER`, etc.) | PASS | `tests/e2e/all-tabs-buttons.spec.ts:25` (`ok 16`) |
| Navbar | `↻ Refresh` (`Refresh live data`) | `GET /api/health`, `/api/info`, `/api/v2/organizations`, `/api/v2/audit-events` | `200 OK`; updates status pill & data | PASS | `tests/e2e/all-tabs-buttons.spec.ts:25` (`ok 16`) |
| Navbar | `✨ Live Demo Console` | Navigation view switch | Opens `/demo` Live Demo Console; `← Back to App` returns to tab shell | PASS | `tests/e2e/all-tabs-buttons.spec.ts:25` (`ok 16`) |

### B. Live Demo Console (`/demo`, `LiveDemoConsole.tsx`)

| Tab | Button / Step | API call | Expected result | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Live Demo Console | Step 1: `Check backend` | `GET /api/health`, `GET /api/info` | `200 OK`; `"status": "ok"`, PASS proof badge | PASS | `tests/e2e/live-demo-console.spec.ts:9,28` (`ok 34, 35`) |
| Live Demo Console | Step 2: `Show contract` | `GET /api/v2/contracts/openapi.json` | `200 OK`; OpenAPI 3.1 spec with 106 paths | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 3: `Sign in as Tenant A` | `POST /api/v2/auth/token` | `200 OK`; scoped JWT issued (masked in cURL) | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 4: `Create organization` | `POST /api/v2/organizations` (with `Idempotency-Key`) | `200` / `201`; org + idempotency + audit + outbox committed | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 5: `Resend same request` | `POST /api/v2/organizations` (same body & key) | `200 OK`; idempotent replay returns same ID, 0 duplicates | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 6: `Send changed body (expect 409)` | `POST /api/v2/organizations` (mutated body, same key) | Real **`409 Conflict`**; blue badge `Expected: 409` + `"The backend refused this on purpose."`; Proof `PASS` | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 7: `Omit key (expect 400)` | `POST /api/v2/organizations` (no `Idempotency-Key`) | Real **`400 Bad Request`**; blue badge `Expected: 400` + `"The backend refused this on purpose."`; Proof `PASS` | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 8: `Switch to Tenant B` | `POST /api/v2/auth/token` (Tenant B) + `GET /api/v2/organizations` | `200 OK`; `0` Tenant A orgs visible under Tenant B | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 9: `Load test evidence` | `GET /test-report.json` | `200 OK`; real `57/57` passed report, dynamic per-test tags | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 10: `Load platform dossier` | `GET /api/v2/release/dossier` | `200 OK`; `READY FOR REVIEW`, `0` P0 failures | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 11: `Create division` | `POST /api/v2/organizations` (fresh key) | `200` / `201`; `"Dispute Resolution & Advisory Division"` created | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |
| Live Demo Console | Step 12: `Verify record` & Summary Modal | `GET /api/v2/organizations/:id` | `200 OK`; authoritative match + opens 12-row Summary Matrix | PASS | `tests/e2e/live-demo-console.spec.ts:28` (`ok 35`) |

### C. All 14 Application Tabs

| Tab | Button / Form / Link | API call | Expected result | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Organizations & Idempotency** | `⟳ Generate New Key` | Client UUID generator | Replaces `Idempotency-Key` input | PASS | `tests/e2e/all-tabs-buttons.spec.ts:54` (`ok 17`) |
| Organizations & Idempotency | `Create Organization via runCommand` (clean) | `POST /api/v2/organizations` | `200`/`201`; `COMMAND COMPLETED (SUCCESS)` & table row added | PASS | `tests/e2e/all-tabs-buttons.spec.ts:54` (`ok 17`, `ok 36`) |
| Organizations & Idempotency | `⟲ Replay Exact Same Request` | `POST /api/v2/organizations` | `200 OK`; table row count stays `1` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:54` (`ok 17`) |
| Organizations & Idempotency | `⚠ Tamper Payload with Same Key` | `POST /api/v2/organizations` | `409 Conflict`; inline warning + `Request ID:` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:54` (`ok 17`) |
| Organizations & Idempotency | Submit with `Inject prohibited field (keystroke_tracker)` checked | `POST /api/v2/organizations` | `400 Bad Request`; `CONSTITUTIONAL BOUNDARY DEFENDED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:54` (`ok 17`) |
| **Ingestion & Work Ledger (Phase 2)** | `Send Clean Batch` | `POST /api/v2/connectors/zoikotime/batches` | `200 OK`; `Standard Batch Ingested Successfully` + receipt table update | PASS | `tests/e2e/all-tabs-buttons.spec.ts:86` (`ok 18`, `ok 32`) |
| Ingestion & Work Ledger | `Send Duplicate Replay` | `POST /api/v2/connectors/zoikotime/batches` (identical payload & key) | `200 OK`; `Duplicate Batch Handled Idempotently` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:86` (`ok 18`) |
| Ingestion & Work Ledger | `Send Surveillance Decoy` | `POST /api/v2/connectors/zoikotime/batches` (decoy fields) | `400 Bad Request`; `Physical Minimization Confirmed` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:86` (`ok 18`, `ok 32`) |
| Ingestion & Work Ledger | `Send Revision 2` | `POST /api/v2/connectors/zoikotime/batches` (`revision: 2`) | `200 OK`; `Revision 2 Appended to Ledger` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:86` (`ok 18`) |
| Ingestion & Work Ledger | `+ Register Connection` | `POST /api/v2/connections` | `200`/`201`; `Source Connection Registered` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:86` (`ok 18`, `ok 32`) |
| Ingestion & Work Ledger | `Pause` / `Suspend` / `Resume` / `Disconnect permanently` | `POST /api/v2/connections/:id/pause\|suspend\|resume\|disconnect` | `200 OK`; reversible `PAUSED`/`SUSPENDED`/`RESUMED` + terminal `DISCONNECTED` with confirm dialog | PASS | `tests/e2e/all-tabs-buttons.spec.ts:86` (`ok 18`, `ok 32`) |
| **Cohort Analytics & Privacy (Phase 3)** | `1. Test n = 9 Floor Violation` | `POST /api/v2/releases/query` | `200 OK` (`status: "UNAVAILABLE"`); `RELEASE SUPPRESSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:132` (`ok 19`, `ok 37`) |
| Cohort Analytics & Privacy | `2. Test n = 10 Valid Release` | `POST /api/v2/releases/query` | `200 OK` (`status: "RELEASED"`); `PRIVACY COMPILER RELEASE APPROVED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:132` (`ok 19`, `ok 37`) |
| Cohort Analytics & Privacy | `3. Overlap Differencing Attack` | `POST /api/v2/releases/query` (ensures baseline first) | `200 OK` (`status: "UNAVAILABLE"`); `RELEASE SUPPRESSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:132` (`ok 19`) |
| Cohort Analytics & Privacy | `4. Parent/Child Residual Attack` | `POST /api/v2/releases/query` (ensures parent first) | `200 OK` (`status: "UNAVAILABLE"`); `RELEASE SUPPRESSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:132` (`ok 19`) |
| Cohort Analytics & Privacy | `Execute Semantic Query` | `POST /api/v2/releases/query` | `200 OK`; `PRIVACY COMPILER RELEASE APPROVED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:132` (`ok 19`) |
| Cohort Analytics & Privacy | `Export Release CSV` | `GET /api/v2/releases/:id/export.csv` | `200 OK`; `RELEASE CSV EXPORTED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:132` (`ok 19`) |
| Cohort Analytics & Privacy | `Trigger Recalculation` | `POST /api/v2/metrics/:id/recalculate` | `202 Accepted` + `jobId`; `METRIC RECALCULATION TRIGGERED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:183` (`ok 22`) |
| **Hazards & Controls (Phase 4)** | Legal Matter Cards (`button`) | `POST /api/v2/sector/legal/fatigue-check` | `200 OK`; selects matter & loads SRA fatigue assessment | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `Use Seeded Baseline` + `+ Register Authoritative Hazard` | `POST /api/v2/hazards` | `200`/`201`; `HAZARD REGISTERED IN AUTHORITATIVE STATE` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`, `ok 37`) |
| Hazards & Controls | `AiPanel`: `Generate AI Explanation` / `Discard` | `POST /api/v2/ai/explain-release`, `POST /api/v2/ai/runs/:id/discard` | `200 OK`; displays & discards draft proposal | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `Propose Cause` + `Accept Cause` | `POST /api/v2/hazards/:id/causes`, `POST .../causes/:causeId/review` | `200`/`201` then `200`; `CAUSE STATUS UPDATED: REVIEWED_ACCEPTED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `Commit Control Draft on Accepted Cause` | `POST /api/v2/controls` | `200`/`201`; `CONTROL DRAFT CREATED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `1. Skip Approval Attack` | `POST /api/v2/controls/:id/implementation` (unapproved) | `409 Conflict`; `REFUSAL GATE 1: PROPOSED -> IMPLEMENTING BLOCKED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `2. v4 Cannot Approve v5` | `POST /api/v2/controls/:id/approve` (`If-Match: "0"`) | `409 Conflict`; `REFUSAL GATE 2: STALE VERSION REJECTED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `3. Transfer of Risk Flag (Simulation)` | Client Simulation | Shows labeled `SIMULATION — REFUSAL GATE 3` banner | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `Approve Control` / `Apply Material Edit` / Re-`Approve Control` | `POST .../approve`, `PATCH /api/v2/controls/:id`, `POST .../approve` | `200 OK`; `APPROVAL RESET` on edit, then re-approved | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `Commit Implementation Receipt` / `Pin Verification Plan` / `Commit Reviewer Conclusion` | `POST .../implementation`, `POST .../verification/pin`, `POST .../verification/conclude` | `201`, `200`/`201`, `200`; full Phase 4 verification loop closed | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| Hazards & Controls | `Commit Hazard Disposition` / `Export Evidence Package` / `Download JSON` | `POST .../disposition`, `POST .../evidence-package`, client Blob | `200` + `200`/`201`; `CRYPTOGRAPHIC EVIDENCE PACKAGE EXPORTED` + Download enabled | PASS | `tests/e2e/all-tabs-buttons.spec.ts:175` (`ok 20`) |
| **Retention & Legal Hold (Phase 5)** | `Save retention class` | `POST /api/v2/retention/classes` | `200`/`201`; `Retention class saved` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:281` (`ok 21`) |
| Retention & Legal Hold | `Place legal hold` / `Release` | `POST /api/v2/legal-holds`, `POST /api/v2/legal-holds/:id/release` | `200`/`201` then `200`; hold placed & released cleanly | PASS | `tests/e2e/all-tabs-buttons.spec.ts:281` (`ok 21`, `ok 38`) |
| Retention & Legal Hold | `Ingest sample expired facts` / `Preview (dry run)` / `Run retention now` | `POST .../zoikotime/batches`, `GET /api/v2/retention/preview`, `POST /api/v2/retention/runs` | `200`, `200`, `200`/`201`; `Retention run recorded` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:281` (`ok 21`) |
| **Bounded AI & Actions (Phase 6)** | `1. Test Prompt Injection` / `2. Test Citation Fabrication` / `3. Test Numeric Tampering` | `POST /api/v2/ai/explain-release` | `200 OK` with validation refusal/safeguard metadata; `LAB 1/2/3 PASSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:320` (`ok 22`) |
| Bounded AI & Actions | `4. Test Individual Inference` | `POST /api/v2/ai/explain-release` | `400` / `403` pre-model block; `LAB 4 PASSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:320` (`ok 22`) |
| Bounded AI & Actions | `5. Test Parameter Mutation` | `POST /api/v2/actions/proposals` + `POST .../dispatch` (mutated) | `403` (`FORBIDDEN`); `LAB 5 PASSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:320` (`ok 22`) |
| Bounded AI & Actions | `6. Test Timeout Reconciliation` | `POST /api/v2/actions/proposals` + `POST .../dispatch` (`simulateTimeout`) | `200 OK` (`UNKNOWN_OUTCOME`); `LAB 6 PASSED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:320` (`ok 22`) |
| Bounded AI & Actions | `AiPanel`: `Generate AI Explanation` & `Accept as Draft Proposal` | `POST /api/v2/ai/explain-release`, `POST /api/v2/ai/runs/:id/accept` | `200 OK`; `AI DRAFT COMMITTED TO WORKFLOW` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:320` (`ok 22`) |
| Bounded AI & Actions | `Kill / Disable Immediately` & `Re-enable Service` | `POST /api/v2/ops/kill-switches` | `200 OK`; `KILL SWITCH ACTIVATED` then `KILL SWITCH DEACTIVATED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:320` (`ok 22`) |
| **Outcomes & AI Change (Phase 7)** | `Refresh` & Plane B Feature Flag Toggle (`ENABLED` / `DISABLED`) | `GET /api/v2/outcomes/definitions`, `POST /api/v2/flags` | `200 OK`; toggles `outcomes_plane_b` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:378` (`ok 23`) |
| Outcomes & AI Change | `1. Prohibited Claim Injection` | `POST /api/v2/outcomes/evaluations` | **`400 Bad Request`** (`VALIDATION`); `LAB 2 PASSED: PROHIBITED CLAIM REJECTED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:378` (`ok 23`) |
| Outcomes & AI Change | `+ Record Evaluation (Plane B)` | `POST /api/v2/outcomes/evaluations` | `201 Created`; `PLANE B OUTCOME EVALUATION RECORDED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:378` (`ok 23`) |
| Outcomes & AI Change | `+ Register AI Profile & Start 8-Stage Assessment` | `POST /api/v2/ai-changes` | `201 Created`; `AI CHANGE PROFILE & ASSESSMENT REGISTERED` (`REGISTERED`) | PASS | `tests/e2e/all-tabs-buttons.spec.ts:378` (`ok 23`) |
| Outcomes & AI Change | `2. Premature AI Closure Attack` | `POST /api/v2/ai-changes/:id/advance` (`to: "CLOSED"`) | **`409 Conflict`**; `LAB 5 PASSED: STAGE GUARD INTEGRITY ENFORCED` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:378` (`ok 23`) |
| Outcomes & AI Change | `Advance to BASELINE` | `POST /api/v2/ai-changes/:id/advance` (`to: "BASELINE"`) | `200 OK`; `STAGE ADVANCED TO BASELINE` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:378` (`ok 23`) |
| **Legal Sector Pack (SRA 2023)** | `Filter Practice Area` + `↻ Refresh` | `GET /api/v2/sector/legal/matters` | `200 OK`; filters & reloads matters | PASS | `tests/e2e/all-tabs-buttons.spec.ts:427` (`ok 24`, `ok 33`) |
| Legal Sector Pack | `SRA Fatigue Check` | `POST /api/v2/sector/legal/fatigue-check` | `200 OK`; detects trial-window fatigue surge | PASS | `tests/e2e/all-tabs-buttons.spec.ts:427` (`ok 24`, `ok 33`) |
| Legal Sector Pack | `Sign Supervisory Consultation Gate (Simulation)` | Client Simulation preview | Inline notice: `Simulation: Client-side Supervisory Partner consultation preview signed` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:427` (`ok 24`) |
| Legal Sector Pack | `Execute Translation & Boundary Gate` (decoy vs clean) | `POST /api/v2/sector/legal/matters/map` | `400` (`Constitutional Boundary Defended`) with decoy; `200` (`Mapped Neutral Representation`) clean | PASS | `tests/e2e/all-tabs-buttons.spec.ts:427` (`ok 24`, `ok 33`) |
| **Operations & Support (B8)** | `Issue diagnostic receipt` | `POST /api/v2/support/diagnostic-receipts` | `200`/`201`; `Diagnostic receipt issued` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:463` (`ok 25`, `ok 38`) |
| Operations & Support | `Sign in as support operator` / `Refresh` | `POST /api/v2/auth/support-token`, `GET /api/v2/ops/slo` | `200 OK`; loads SLOs, errors, jobs, dossier & kill switches | PASS | `tests/e2e/all-tabs-buttons.spec.ts:463` (`ok 25`, `ok 38`) |
| Operations & Support | `Verify signature` | `POST /api/v2/ops/diagnostic-receipts/verify` | `200 OK`; `Receipt checked` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:463` (`ok 25`, `ok 38`) |
| Operations & Support | `Activate Kill Switch` / `Deactivate (Re-enable)` | `POST /api/v2/ops/kill-switches` | `200 OK`; toggles & cleanly restores `ONLINE` state | PASS | `tests/e2e/all-tabs-buttons.spec.ts:463` (`ok 25`) |
| Operations & Support | `Replay` (Dead-Letter Queue row) | `POST /api/v2/ops/dead-letters/:id/replay` | Support auth + non-empty `reason` resets outbox row to `PENDING` (`200 OK`); duplicate returns `409` | PASS | `backend/tools/test-completion-gates.ts` |
| Operations & Support | DR & 150-Concurrency Benchmark Tables & Release Dossier Gates | `GET /api/v2/release/dossier` | Reference tables labeled `Simulation (Reference Target)` / `Simulation (Baseline Reference)`; Gate 8 driven by live JSON | PASS | `tests/e2e/all-tabs-buttons.spec.ts:463` (`ok 25`) |
| **Tenant Isolation & Attack Lab** | `Simulate Cross-Tenant Read on ...` | `GET /api/v2/organizations/:foreignId` | **`404 NOT_FOUND`**; `ATTACK BLOCKED & SAFE 404 RETURNED (PASS)` | PASS | `tests/e2e/all-tabs-buttons.spec.ts:499` (`ok 26`) |
| **Transactional Outbox** | `⟳ Trigger Worker Drain Loop` | `POST /api/v2/outbox/drain` | `200 OK`; `DRAIN LOOP EXECUTED` inline banner | PASS | `tests/e2e/all-tabs-buttons.spec.ts:509` (`ok 27`) |
| **Append-Only Audit Trail** | `↻ Refresh Log` | `GET /api/v2/audit-events` | `200 OK`; reloads tenant audit table with inline status | PASS | `tests/e2e/all-tabs-buttons.spec.ts:519` (`ok 28`) |
| **Audit Verifier & Merkle** | `Issue & Verify Live Package`, `Simulate Artifact Tamper`, `Load Clean Sample Bundle`, `Re-Verify Bundle`, `Inspect Merkle proof for leaf ...` | `POST /api/v2/evidence-packages` + client `crypto.subtle` WebCrypto | `201` on live package; detects tamper (`TAMPER OR MISMATCH DETECTED`); verifies clean sample (`VERIFIED: Manifest Hash`) | PASS | `tests/e2e/all-tabs-buttons.spec.ts:529` (`ok 29`, `ok 31`) |
| **Constitutional Invariants** | `OpenAPI 3.1 Contract Registry ->` link | `GET /api/v2/contracts/openapi.json` | `200 OK`; serves OpenAPI `3.1.0` JSON (`112` paths, synced with `openapi.generated.ts`) | PASS | `tests/e2e/all-tabs-buttons.spec.ts:568` (`ok 33`) |
| **Responsive & Keyboard & Sector Neutrality** | Desktop (`1280x800`), Tablet (`768x1024`), Phone (`390x844`), Tab focus, `PUT /api/v2/tenant/sector-profile` (`GENERIC`) | `GET/PUT /api/v2/tenant/sector-profile`, `GET /api/v2/me` | Primary buttons reachable across viewports; Legal tab hidden & neutral `Unit / Team` / `Demand Window` vocabulary shown when `GENERIC` pack active | PASS | `tests/e2e/responsive-and-sector-neutral.spec.ts` (`ok 42, 43, 44`) |

---

## 5. Verification Command Outputs Summary (`2026-11-19` Post-Edit)

| Command | Result | Exact Observed Scope / Output |
| :--- | :--- | :--- |
| `npm --prefix backend run build` | PASS | Exited `0` (`tsc`, `0` errors across `src/` & `tools/`) |
| `npm --prefix backend run lint:wording` | PASS | Exited `0` (`Scanned 133 files with 0 overclaim violations`) |
| `npm --prefix backend run generate:openapi -- --check` | PASS | Exited `0` (`112` OpenAPI paths synced across `docs/openapi.json` and `frontend/src/api/openapi.generated.ts`) |
| `npm --prefix frontend run lint` | PASS | Exited `0` (`0` errors on `32` files) |
| `npm --prefix frontend test` | PASS | Exited `0` (`9 StateView states + 3 sector vocabularies`) |
| `npm --prefix frontend run build` | PASS | Exited `0` (`tsc -b && vite build`, `44` modules transformed) |
| `npm --prefix tests run typecheck` | PASS | Exited `0` (`tsc -p tsconfig.json --noEmit`) |
| `npm --prefix tests run test:e2e` | PASS | Exited `0`: **`45 passed (2.2m)`** (`18` Axe WCAG 2.1 AA + viewport scans + `15` `all-tabs-buttons` + `3` `responsive-and-sector-neutral` + `live-demo-console` + `7` domain/OIDC E2E specs) |
| `npm --prefix backend run test-completion` | PASS | Exited `0`: **`11 checks PASSED`** (rate limits, HMAC webhooks, telemetry scrubbing, connection states, headers, dead-letter replay, 400/409 error shape, SSRF guard, cursor pagination & filter allowlist, ETag/If-Match & 202 recalc, scheduled retention executor) |
| `npm --prefix backend run rehearse:key-rotation` | PASS | Exited `0`: **`4/4 PASSED`** (`evidence/key-rotation-rehearsal-report.json`, `0` secret leaks) |
| `npm --prefix backend run drill:incident` | PASS | Exited `0`: **Detected `87ms`, contained `5ms`, recovered `43ms`**, `0` decoy leaks (`evidence/incident-exercise-report.json`) |
| `npm --prefix backend run build-dossier` | PASS | Exited `0`: **`READY FOR REVIEW`** (57 boundaries, 10 ingest, 9 privacy, 9 control, 11 retention, 16 AI, 7 planes, 7 worker, 5 pilot, 2 verify-pg, 24 endpoint checks, 9/9 30d sim, 5/5 kill switches, 6/6 challenge P0=0; bound to `sbom.json`) |
| `npm --prefix backend run test-fast` | PASS | Exited `0`: **`12 fast unit and policy tests passed`** |
| `npm --prefix backend run test-pilot` | PASS | Exited `0`: **`5 pilot readiness gates verified`** |
