# Zoiko Abate — Complete Plain-English Explanation of Abate, Errors Fixed, Frontend Tabs, All 12 Demo Steps, and Phases 0–8

> **Core Philosophy:** **"Change the work. Not the worker."**
> **Purpose of This Document:** Explains **what Zoiko Abate is**, **why we are using it (the business, legal, and privacy reasons)**, **every error checked and fixed** from the Live Demo screenshot and Playbook PDF review, **all 12 Live Demo Console steps (`/demo`)**, and **every engineering phase (`Phase 0` through `Phase 8` + UK Legal Sector Pack)** across the frontend and backend.

---

## 1. What Is Zoiko Abate & Why Are We Using It?

### What Abate Is
**Zoiko Abate** is **organizational work-design and psychosocial-risk infrastructure** built first for high-pressure legal services organizations (law firms and chambers) and designed to generalize across sectors via configuration packs.

Abate helps organizations identify structural work overload patterns (after-hours intrusion, unsustainable meeting/matter deadlines, fragmented work handoffs, or poorly governed AI rollouts), design and approve workplace interventions, and prove with cryptographic audit trails whether those interventions actually reduced risk.

### Why Are We Using It? (The Reason Abate Exists)
Organizations facing burnout, attrition, and workplace psychosocial-risk regulations usually fall into one of two bad traps:

1. **Do Nothing / Checklist Theater:** Guess from surveys or tick compliance boxes ("we ran a wellness webinar") without measuring real work patterns or verifying if risk actually dropped.
2. **Invasive Workplace Surveillance ("Bossware"):** Deploy screenshots, keystroke counters, email sentiment mining, URL tracking, or individual "burnout/productivity risk scores." That destroys employee trust, violates data-minimization and privacy laws, and enables punitive targeting of individuals.

**Abate solves both problems at the engineering architecture level:**
- **Measures the *work system*, never the individual:** Outputs are strictly aggregated to cohorts of **at least `10` distinct contributors** (`n >= 10`) with overlap/residual reconstruction defenses (`>= 5` symmetric difference). Nobody—not even admins, support, or AI—can extract individual employee scores.
- **Physically prevents overcollection:** Connectors use strict allowlisted contracts (`Zod .strict()`). If an upstream system sends forbidden data (`screenshotUrl`, `keystrokes`, `sickReason`, `emailBody`), it is rejected before hitting any database table, log, queue, or trace.
- **Separates Risk Safety (Plane A) from Performance Outcomes (Plane B):** Higher billing output or faster throughput can **never** automatically close an unresolved safety hazard. Only a named human reviewer using verified post-intervention evidence can close a risk obligation.
- **Works even with AI turned completely off:** AI (`Phase 6`) is bounded strictly to read *already-released* cohort numbers, draft proposals with citations, and pass output validators. It has zero authority to change safety state, invent numbers, or access hidden raw tables.

### Stack Note: Playbook Reference PDF vs. This Repository
The engineering specification PDF (*"Abate on Next.js Backend, APIs and Frontend"*, derived from `ZAB-ENG-001`) uses **Next.js App Router** as its structural blueprint, whereas this repository implements a **decoupled TypeScript stack** with the exact same `/api/v2/*` contract, database role isolation, and constitutional guarantees:

| Layer | Playbook PDF Blueprint | This Repository (`Abate/`) |
| :--- | :--- | :--- |
| **Frontend UI** | Next.js App Router (`apps/web`) | **React 19 + Vite + TypeScript** (`frontend/`) with **14 domain tabs** + **`/demo` Live Demo Console** |
| **HTTP API Server** | Next.js `/api/v2/*` route handlers | **Express + TypeScript** (`backend/src/index.ts`) on port `5000`, OpenAPI 3.1 contract (`backend/src/contracts/openapi.ts`) |
| **Background Worker** | `apps/worker` Node process | **Node Worker Daemon** (`backend/src/worker/daemon.ts` + `outbox-publisher.ts`) using `FOR UPDATE SKIP LOCKED` |
| **Database & Isolation** | PostgreSQL (`pg`) with Forced RLS | **PostgreSQL 16.2 (`node-postgres` / `pg`)** with Forced RLS + restricted roles (`abate_app`, `abate_worker`, etc.) + local `MemoryDatabase` sandbox fallback |
| **Object Storage** | S3-compatible (MinIO locally) | **SigV4 S3 Client** (`backend/src/platform/object-store.ts`) + `memory` mode in `local`/`test` (`s3` mandatory in `staging`/`production`) |

---

## 2. Errors Checked & Code Updates Applied

During the side-by-side audit of the **Live Demo Audit Verification Summary screenshot**, the **daily endpoint verification log (`docs/endpoint-checks/2026-11-17.md`)**, and the **Playbook PDF**, every issue below was identified and fixed or transparently documented:

### A. Frontend Bugs Found & Fixed
1. **Swapped Demo Input Forms on Steps 6 & 7 vs. Steps 11 & 12 (`frontend/src/components/Demo/LiveDemoConsole.tsx`):**
   - *Error found:* Selecting **Step 6 (`Change Body, Same Key` expecting `409`)** erroneously rendered the **Step 11** inputs (*Secondary Division Name* and *Fresh Idempotency-Key*), and selecting **Step 7 (`Skip the Key` expecting `400`)** erroneously rendered the **Step 12** inputs (*Target Organization ID* and *Verified Tenant Context*), leaving Steps 11 and 12 without their form cards.
   - *Fix applied:* Rebound each step to its real inputs: Step 6 now shows *Mutated Body Name* (`"Tampered Organization Name"`) + *Reused Idempotency-Key*; Step 7 shows *Payload Name* (`"Keyless Organization"`) + *Idempotency-Key Header: OMITTED*; Step 11 shows *Secondary Division Name* + actual synced `secondaryIdempotencyKey`; Step 12 shows *Target Organization ID* + *Verified Tenant Context*.
2. **False Storage Technology Description (`frontend/src/components/Demo/WhatHappened.tsx`):**
   - *Error found:* Step 1 explanation previously claimed `"real SQLite/pgmem storage"`—neither SQLite nor `pgmem` is used in Abate.
   - *Fix applied:* Corrected Step 1 to accurately describe the **Express + TypeScript** backend running against **PostgreSQL 16.2 (Forced RLS)** or the local sandbox store fallback, plus live object-store mode (`memory`/`s3`).
3. **Stale Demo Tenant Names & Audit Command Name (`LiveDemoConsole.tsx` & `WhatHappened.tsx`):**
   - *Error found:* Step 8 and fallback labels used old names (`Acme Corp`, `Beta Corp`, `alice@acme.corp`, `tenant.create_organization`) that contradicted `PRESET_TENANTS`, seed fixtures, and `organizations` audit records.
   - *Fix applied:* Standardized to the real seeded entities **`Apex Legal Partners (Tenant A)`** (`00000000-0000-4000-a000-00000000000a`, `auth0|user-tenant-a-risk-owner`), **`Beacon Chambers (Tenant B)`** (`00000000-0000-4000-b000-00000000000b`), and real audit command **`organization.create`**.
4. **Hardcoded Stale Suite Counts on Step 10 (`LiveDemoConsole.tsx` & `WhatHappened.tsx`):**
   - *Error found:* Step 10 hardcoded `"8 test suites, 110 automated cases"` even as the real Release Evidence Dossier grew to **10 backend test suites + 3 operational drills + verifier (`140+` checks)**.
   - *Fix applied:* Step 10 now reads live `testSuites.length` and `totalChecksPassed` directly from `GET /api/v2/release/dossier`.
5. **Header Phase Scope & Keyboard Shortcut Stale Closure (`LiveDemoConsole.tsx`):**
   - *Error found:* Top bar sub-label said `"Phase 0 & 1 Constitutional Verification"` despite covering the full stack dossier; `useEffect` keyboard handler (`R` key) captured an initial closure of `executeStep`.
   - *Fix applied:* Updated label to `"Phases 0–8 & Legal Pack Live Verification"`, added `executeStepRef`, and embedded **"Why We Use This (The Reason)"** directly inside both `LiveDemoConsole.tsx` and `ConstitutionalTab.tsx`.

### B. Backend Security Header Fix & Known Playbook Differences
1. **Added `Cache-Control: no-store` on `/api/v2/*` (`backend/src/platform/telemetry.ts`):**
   - *Why:* Matches Playbook §C.2 (`Cache-Control: no-store` on authenticated responses) so browsers and shared proxies never cache tenant data, while keeping public `/test-report.json` readable.
2. **`POST /api/v2/organizations` Status `200` vs. Playbook `201`:**
   - *Observation:* In `backend/src/platform/command.ts`, `runCommand()` returns HTTP `200` on first creation and `200` on idempotent replay (matching the Demo Audit Summary screenshot, `endpoint-check.ts` expecting `200 / 201`, and `simulate-30d-http.ts`). The Playbook PDF §D.1/§E proposes `201 Created` + `ETag`. We preserved `200` for runtime consistency with existing suites and documented this intentionally here.
3. **Authentication Mode (Stage B Open Item vs. Pilot Readiness):**
   - *Observation:* In `local` and `test` environments (used for the Demo Console and E2E suite), `POST /api/v2/auth/token` mints dev JWTs (`AUTH_SECRET`). In `staging` and `production`, `POST /api/v2/auth/token` already returns `404 NOT_FOUND`. Full OIDC JWKS verification + PKCE browser session login (with HttpOnly cookies instead of browser state tokens) is scheduled in **Stage B Item 6** after independent challenge clearance (Items 4–5).

---

## 3. Live Demo Console (`/demo`) — Step-by-Step Explanation

Accessible from **"Live Demo Console"** in the top navbar or directly at `http://localhost:5173/demo` (`frontend/src/components/Demo/LiveDemoConsole.tsx` + `WhatHappened.tsx`):

| Step | Screen Title & Endpoint | What It Does in Frontend & Backend | Why We Are Using It (The Reason) | What to Say in a Demo |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Check Backend**<br>`GET /api/health` & `GET /api/info` | Pings Express (`:5000`), reads environment, object store health, and lists all registered domains (`S01`–`S12`). | Proves the UI is backed by a live TypeScript enforcement engine—never a hardcoded frontend slide deck. | *"This is the running backend checking live object storage and constitutional boundaries."* |
| **2** | **Show Contract**<br>`GET /api/v2/contracts/openapi.json` | Fetches the OpenAPI 3.1 JSON spec generated from strict Zod schemas and renders every route in a table. | One contract registry guarantees frontend, backend, and connectors share exact shapes and reject unknown surveillance fields. | *"Every allowed field, enum, and error shape comes from one canonical contract."* |
| **3** | **Sign in as Tenant A**<br>`POST /api/v2/auth/token` | Requests a dev-scoped JWT for **Apex Legal Partners (Tenant A)** with `tenant_id`, `sub`, and `RISK_OWNER` role. | Tenant identity is extracted cryptographically from the verified token—never trusted from URL params or JSON request bodies. | *"The tenant comes strictly from the signed token claim, never from user input."* |
| **4** | **Create Organization**<br>`POST /api/v2/organizations` | Sends `{ name }` with a UUID `Idempotency-Key`. Executes `runCommand()`: writes `organization`, `idempotency_record`, `audit_event`, and `outbox_event` in 1 transaction. | Guarantees atomic 4-way consistency: a firm unit cannot exist without an audit record and an outbox notification. | *"One click, one key: data, idempotency lock, audit log, and outbox commit atomically."* |
| **5** | **Resend Same Request**<br>`POST /api/v2/organizations` (Replay) | Sends the exact same `Idempotency-Key` and body again, then lists orgs to prove count is still `1`. | Prevents double-clicks, mobile timeouts, or webhook retries from creating duplicate divisions or double-counting events. | *"Same key and same body over a flaky network returns the stored result with zero duplicates."* |
| **6** | **Change Body, Same Key**<br>`POST /api/v2/organizations` (`409`) | Reuses Step 4's `Idempotency-Key` while mutating `{ name: "Tampered Organization Name" }`. Expects `HTTP 409 CONFLICT`. | Binds each key to `sha256(canonicalJson(body))` so altered retries or hijacked keys fail closed instead of overwriting history. | *"Reusing an old key with altered content is blocked cleanly with 409 Conflict."* |
| **7** | **Skip the Key**<br>`POST /api/v2/organizations` (`400`) | Deliberately omits the `Idempotency-Key` header on `POST /api/v2/organizations`. Expects `HTTP 400 VALIDATION`. | Forces every mutating route to enforce idempotency at the HTTP gateway before touching storage. | *"Mutations without an Idempotency-Key fail fast at the gateway before any DB transaction starts."* |
| **8** | **Switch to Tenant B**<br>`GET /api/v2/organizations` (RLS) | Authenticates as **Beacon Chambers (Tenant B)** and compares `GET /api/v2/organizations` side-by-side against Tenant A. | Proves PostgreSQL **Forced Row-Level Security** (`set_config('app.tenant_id', ..., true)`) hides Tenant A's newly created division inside storage itself. | *"Tenant isolation lives inside PostgreSQL storage rules under a restricted non-owner role."* |
| **9** | **Test Evidence**<br>`GET /test-report.json` | Loads the `57/57` automated report from `npm run test-boundaries` showing every assertion and latency. | Proves isolation, decoy minimization, `n >= 10` suppression, and Plane A/B barriers pass automated adversarial execution. | *"Not just UI clicks—57 automated boundary and attack tests prove it continuously."* |
| **10** | **Platform Release Dossier**<br>`GET /api/v2/release/dossier` | Fetches the machine-assembled dossier across all suites (`10` backend suites + `3` operational drills + verifier) & displays Phase 0–8 cards. | Prevents unverified releases; dossier stays `READY FOR REVIEW` until measured evidence passes and a named authority signs via `sign-dossier.ts`. | *"All phases 0 through 8 and the UK legal pack are machine-verified and ready for human governance review."* |
| **11** | **Create Secondary Division**<br>`POST /api/v2/organizations` (Extra) | Creates `Dispute Resolution & Advisory Division` using a brand-new `Idempotency-Key` (`idem-sec-...`). | Demonstrates idempotency only blocks duplicates of an existing intent; genuine new organizational cohorts commit cleanly. | *"A fresh business intent with a fresh key receives its own independent atomic transaction."* |
| **12** | **Verify Organization Record**<br>`GET /api/v2/organizations/:id` | Queries the specific UUID created earlier using Tenant A's token and inspects `X-Request-Id` telemetry. | Proves single-record ownership lookup works cleanly for Tenant A while returning identical `404` for nonexistent or Tenant B lookups. | *"Authoritative reads are instantly available to authorized tenant roles with full request correlation."* |

---

## 4. Complete Phase-by-Phase Guide in the Frontend (`Phase 0` to `Phase 8`)

Every navigation tab in the main application (`http://localhost:5173`, orchestrated by `frontend/src/App.tsx`) corresponds to the progressive delivery phases of Playbook `ZAB-ENG-001`.

---

### Phase 0 — Foundation: Constitutional Boundaries, Database Roles & Synthetic Baseline
- **Frontend Tab:** `Constitutional Invariants` (`ConstitutionalTab.tsx`) + Header Bar (`Navbar.tsx`)
- **Playbook Package:** `B0` (Foundations, ADR-000..005, Golden Fixture `ABATE-GOLDEN-01`)
- **What It Does:**
  - Displays live `/api/health` + `/api/info`, the **6 Non-Negotiable Constitutional Boundaries** (zero individual scoring, zero surveillance, zero clinical diagnosis, zero AI training on customer workforce data, `n >= 10` cohort floor, proposal-only AI), the **Two Value Planes**, the **12 Core Domains (`S01`–`S12`)**, and the built-in plain-English **Phases 0–8 Roadmap**.
- **Why We Built This First (The Reason):**
  - Security and privacy guarantees cannot be trusted if tests run as a database superuser or rely on fragile local laptops. Establishing separated least-privilege DB roles (`abate_migrator` vs. restricted `abate_app` / `abate_worker`), strict OpenAPI contracts, and synthetic-only fixtures ensures reproducible proof from day one.
- **Playbook Exit Proof:** Clean repo boots; restricted role fails closed on cross-tenant read; CI blocks invalid imports/schemas; synthetic seed refuses `staging`/`production`.

---

### Phase 1 — Tenancy, Identity, Forced RLS & Atomic Command Pipeline
- **Frontend Tabs:**
  - `Organizations & Idempotency` (`OrganizationsTab.tsx`)
  - `Tenant Isolation & Attack Lab` (`IsolationTab.tsx`)
  - `Transactional Outbox` (`OutboxTab.tsx`)
  - `Append-Only Audit Trail` (`AuditTab.tsx`)
- **Playbook Package & Domain:** `B1` / `S01` (`tenant`, `principal`, `organization`, `effective_membership`, `idempotency_record`, `audit_event`, `outbox_event`, `inbox_event`)
- **What Each Tab Shows in the Frontend:**
  - **Organizations & Idempotency:** Create an organizational practice/division; immediately click **"Replay Exact Same Request"** (`200` idempotent replay, zero duplicate rows), **"Tamper Payload with Same Key"** (`409 Conflict`), or test missing `Idempotency-Key` (`400`).
  - **Tenant Isolation & Attack Lab:** Actively attempts cross-tenant IDOR reads (querying Tenant A's UUID while signed in as Tenant B) and verifies identical `404 Not Found` refusal plus pooled connection safety.
  - **Transactional Outbox:** Lists pending `outbox_event` rows created inside transactions and lets you manually trigger worker draining (`POST /api/v2/outbox/drain`) to publish events via `inbox_event` deduplication.
  - **Append-Only Audit Trail:** Displays immutable `audit_event` rows (`UPDATE` and `DELETE` revoked from runtime DB role `abate_app`).
- **Why We Are Using It (The Reason):**
  - If Tenant B can ever read or infer Tenant A's existence, or if a double-click duplicates records/drops events, downstream analytics and compliance packages are worthless. Forced RLS (`withTenant`) guarantees tenant isolation inside PostgreSQL itself, and `runCommand()` prevents partial writes.
- **Playbook Exit Proof:** Two tenants isolated across API, PostgreSQL (`abate_app`), object keys, and outbox/inbox worker crash labs.

---

### Phase 2 — Allowlisted Ingestion Without Overcollection & Work-State Ledger
- **Frontend Tab:** `Ingestion & Work Ledger (Phase 2)` (`IngestionTab.tsx`)
- **Playbook Package & Domains:** `B2` / `S02` (Connectors) & `S03` (Work-State Ledger)
- **What It Does in the Frontend:**
  - Displays registered **Source Contracts** (`ZoikoTime v1.0`, `CalendarCadence v1.0`) and **Connector Health** (`FRESH`, `DELAYED`, `STALE`, `NEVER_SYNCED`).
  - Lets operators **Pause / Resume / Revoke** connections (`If-Match` / atomic checks) so revoked connectors stop immediately.
  - Provides interactive **Clean Batch Ingestion**, **Duplicate Batch Replay** (`accepted: 0, duplicate: 1`), **Revision 2 Correction Append** (marks downstream metric snapshots stale without erasing revision 1), and a **Decoy Surveillance Attack Button** sending prohibited fields (`screenshotUrl`, `windowTitle`, `sickReason`).
  - Uses explicit **HMAC-SHA256 tenant-scoped pseudonyms** (`work_fact_revision.subject_pseudonym`) kept physically isolated from `identity_map`.
- **Why We Are Using It (The Reason):**
  - Prevents Abate from accidentally storing invasive employee surveillance data even if a customer's connector misconfigures an export. Ensures `"no data"` from a broken feed surfaces as honest **`STALE` health**, never falsely reporting `"0% after-hours work / improved wellbeing"`.
- **Playbook Exit Proof:** Decoy strings appear in **0** DB tables, logs, receipts, DLQs, object store, or traces; duplicate batches add zero work minutes; outages turn feeds `STALE`.

---

### Phase 3 — Deterministic Measurement & Privacy Release Compiler
- **Frontend Tab:** `Cohort Analytics & Privacy (Phase 3)` (`CohortAnalyticsTab.tsx`)
- **Playbook Package & Domains:** `B3` / `S04` (Deterministic Measurement) & `S06` (Privacy Release Compiler)
- **What It Does in the Frontend:**
  - Lets users test `BOUNDARY_INTRUSION_SHARE` (`outside_schedule_minutes / total_work_minutes` using mathematical interval **union**, never naive double-counting sums).
  - Exercises the **Privacy Release Compiler** (`POST /api/v2/releases/query` + `GET /api/v2/releases/:id`):
    - Selecting a cohort with `n = 9` contributors returns `{ status: "UNAVAILABLE", code: "NOT_AVAILABLE" }` with **no count leaked** (UI tells you to try a broader group or longer period—never saying *"only 9 people"*).
    - Selecting `n = 10` releases **value, unit, period, quality state (`VALID`/`PARTIAL`/`STALE`/`INSUFFICIENT_DATA`/`NOT_APPLICABLE`), interpretation, limits, and Plane `A` badge**.
    - Demonstrates **Overlap (`symmetric difference < 5`)** and **Parent/Child Residual (`< 5`)** suppression across concurrent requests serialized by PostgreSQL advisory lock (`pg_advisory_xact_lock`).
    - Exports CSV strictly from `released_artifact` via the **Single Read Path** (even CSV row counts never expose hidden contributors) and supports metric recalculation jobs.
- **Why We Are Using It (The Reason):**
  - Setting `n >= 10` alone can be bypassed if an attacker queries a 14-person department and a 10-person subteam (`14 - 10 = 4` residual), or sends two simultaneous API queries racing past a disclosure budget. Serializing disclosure accounting at the database layer stops reconstruction attacks across dashboard, CSV, support, and AI channels simultaneously. *(Note: Stage B Item 1 explicitly decides keeping deterministic suppression gates vs. adding calibrated noise without overclaiming "differential privacy".)*
- **Playbook Exit Proof:** Hand-computed golden values match exactly; `n = 9` suppressed everywhere; `n = 10` still blocked if overlap/residual `< 5`; concurrent `Promise.all` requests serialize strictly.

---

### Phase 4 — Hazard, Cause, Version-Bound Control Approval & Verification Workflow
- **Frontend Tab:** `Hazards & Controls (Phase 4)` (`HazardControlTab.tsx`)
- **Playbook Package & Domains:** `B4` / `S05` (Hazards & Organizational Causes) & `S07` (Controls, Approvals, Verification)
- **What It Does in the Frontend:**
  - Completes Abate's **core operational workflow**:
    1. Open a **Hazard** anchored to a `RELEASED` Phase 3 `originatingReleaseId`.
    2. Propose an **organizational Cause** (structural schedule/staffing cause—never naming an individual) -> human reviewer accepts/rejects.
    3. Create a **Control / Intervention**, advance the 14-state machine (`DRAFT -> PROPOSED -> APPROVAL_REQUIRED -> APPROVED -> IMPLEMENTING -> IMPLEMENTED -> VERIFYING -> CLOSED`), sending **`If-Match`** headers.
    4. **Material Hash Binding (`v4 cannot approve v5`):** Editing scope, owner, due date, objective, or verification plan bumps `version` and resets prior approval so outdated sign-offs cannot authorize mutated controls.
    5. **Verification Plan Before Results (`PIN_PLAN` -> `CONCLUDE`):** Pins baseline/post periods and adjacent cohorts *before* comparing outcomes. If primary cohort improves while an adjacent team worsens, Abate flags **`TRANSFER_OF_RISK`** (`PARTIALLY_EFFECTIVE`) and blocks automatic closure.
    6. **Separate Three States:** `intervention.state`, `evaluation.outcome`, and `hazard.disposition` stay strictly separated, ending in an **Evidence Package export**.
- **Why We Are Using It (The Reason):**
  - *"An implemented task is not an effective control."* Shipping a new policy or calendar rule doesn't prove burnout dropped—and overworking Team B to lighten Team A just hides risk. Locking verification criteria before results appear eliminates cherry-picking.
- **Playbook Exit Proof:** Editing approved v4 invalidates approval before execution; adjacent cohort worsening flags risk transfer; evidence package exports full provenance hashes.

---

### Phase 5 — Governance, Jurisdiction Packs, Evidence Verification & GDPR Lifecycle
- **Frontend Tabs:**
  - `Retention & Legal Hold (Phase 5)` (`RetentionTab.tsx`)
  - `Audit Verifier & Merkle` (`AuditVerifierTab.tsx`)
- **Playbook Package & Domains:** `B5` / `S10` (Governance & Evidence), `S11` (Commercial Entitlements), `S12` (Retention, Legal Hold, Erasure)
- **What Each Tab Shows in the Frontend:**
  - **Retention & Legal Hold:**
    - Inspects effective-dated **Jurisdiction Packs** (`legal-uk-sra`, `legal-uk-bar`) separated cleanly across three independent axes: **Cloud Region**, **Legal Jurisdiction**, and **Commercial Entitlement**.
    - Configures retention policy bounded by pack floor/ceiling (refuses invented defaults or out-of-range durations).
    - Places/releases scoped **Legal Holds**, triggers **GDPR Erasure (`requestErasure`)**, stores cryptographic **`deletion_tombstone` digests** (zero raw pseudonyms), and verifies the **Anti-Resurrection Guard** so re-ingesting purged facts is classified `DUPLICATE` instead of resurrecting deleted history.
  - **Audit Verifier & Merkle:**
    - Runs browser **Web Crypto SHA-256 + Merkle Tree (`abate.merkle.v1`)** verification directly inside the UI (no server trust needed!), includes a live **"Simulate 1-Byte Tamper"** test proving instant mismatch detection, and verifies exported evidence JSON bundles offline matching `backend/tools/verify-evidence.ts`.
- **Why We Are Using It (The Reason):**
  - Organizations operate under varying national/sector laws (`SRA`, `Bar`), hold active litigation holds, and face GDPR erasure requests. Crucially, **restoring a database backup can accidentally resurrect deleted user data** unless deletion tombstones are reconciled cleanly against the restored snapshot (`measure-pg-restore.ts` & `reconcile-after-restore.ts`).
- **Playbook Exit Proof:** Expired jurisdiction packs block new compliance claims cleanly; 1-byte tamper breaks verification immediately; deleted facts never return after restore.

---

### Phase 6 — Bounded AI, Output Validators, Safe Action Broker & Kill Switches
- **Frontend Tab:** `Bounded AI & Actions (Phase 6)` (`BoundedAiTab.tsx`) + Shared Panel (`AiPanel.tsx`)
- **Playbook Package & Domains:** `B6` / `S08` (AI Request Pipeline) & `S09` (Fenced Action Execution)
- **What It Does in the Frontend:**
  - Runs 3 bounded AI use cases (`explain_release`, `draft_cause`, `draft_control`) displaying explicit **Proposal Status (`Not accepted`)**, clickable **Citations**, **Uncertainty notes**, **"Use as a draft"** (creates an unapproved draft only), or **Discard**.
  - Demonstrates **Prompt Injection Defense & Output Validators** (`SCHEMA`, `CITATION`, `NUMERIC_FIDELITY`, `CONTROL_ELIGIBILITY`, `PROHIBITED_INFERENCE` -> `REJECTED_BY_VALIDATOR`), rejecting any AI text mentioning individuals or altered percentages.
  - Exercises **Action Broker Proposals & Short-Lived Grants (`mintGrant` / `verifyGrant` / fencing tokens / `UNKNOWN_OUTCOME` reconciliation)** so approved notification parameters cannot be mutated before dispatch.
  - Toggles **5 Independent Kill Switches** (`connector:*`, `release_path`, `pack:*`, `all_ai`, `tool:*`) demonstrating that turning off AI still lets the entire manual governance lifecycle succeed.
- **Why We Are Using It (The Reason):**
  - Employers want AI summaries of complex cohort metrics, but unguarded LLMs hallucinate numbers, leak employee names under prompt injection, or fire unauthorized external actions on retries. Bounded retrieval (`getRelease` only), deterministic post-validators, and short-lived parameter-bound grants contain worst-case failures.
- **Playbook Exit Proof:** Prompt injection rejected; altered numbers/citations rejected; mutated dispatch parameters fail grant signature checks; full manual workflow completes when `all_ai` kill switch is active.

---

### Phase 7 — Plane B Work-Design Outcomes & AI Work-Design Risk Assessment
- **Frontend Tab:** `Outcomes & AI Change (Phase 7)` (`OutcomesAiChangeTab.tsx`) + Badges (`PlaneBadge.tsx`, `PermittedClaims.tsx`)
- **Playbook Package:** `B7` (Two-Plane Separation & AI Work-Design Change Governance)
- **What It Does in the Frontend:**
  - Feature-flagged **off by default** (`outcomes_plane_b`); shows explicit `Risk assurance (Plane A)` vs. `Work-design outcome (Plane B)` badges so the two are never visually merged.
  - Models the 4 outcome families (`WORKLOAD_SUSTAINABILITY`, `ROLE_CLARITY`, `FRAGMENTATION`, `AI_REWORK_RATE`), enforcing **Permitted Claims** ("associated with improvement" rather than "hazard controlled") and testing cross-plane blocks.
  - Walks through the **8-stage AI Work-Design Risk Assessment** workflow (`REGISTERED -> BASELINE -> DETECT -> ATTRIBUTE -> CONTROL -> VERIFY -> PERFORMANCE_REVIEW -> CLOSED`), refusing closure while any referenced Plane A hazard or control remains open.
- **Why We Are Using It (The Reason):**
  - Productivity dashboards often pressure teams to declare "success" while safety risks are still unresolved, especially during AI copilot rollouts that speed up draft output while increasing review fatigue/fragmentation. PostgreSQL triggers (`assert_plane_a`) and separated command permissions make cross-plane closure mathematically impossible.
- **Playbook Exit Proof:** Improved outcome metrics, replayed events, AI drafts, or `abate_performance` direct SQL updates all fail to close an open Plane A hazard.

---

### UK Legal Sector Pack (Domain Extension Across Phases 2, 4, 5)
- **Frontend Tab:** `Legal Sector Pack (SRA 2023)` (`LegalPracticeTab.tsx`)
- **What It Does in the Frontend:**
  - Maps neutral Abate concepts (`work_item`, `demand_window`) onto legal matters, practice areas, and peak demand windows (`TRIAL_PREP`, `TRIAL`, `CLOSING`, `FILING_DEADLINE`).
  - Demonstrates mandatory **Supervisory Partner Consultation Gates** before closing high-strain legal controls and shows **Privilege Boundary Refusal** blocking ingestion of client-privileged notes or substantive legal work product.
- **Why We Are Using It (The Reason):**
  - Legal services carry unique statutory demand spikes (trial windows) and strict solicitor-client confidentiality rules. Keeping legal rules cleanly inside configurable sector/jurisdiction packs (`legal-uk-sra`) keeps Abate's core engine reusable across other professions. *(Framed accurately as `"SRA-aligned"` workplace risk governance pending Legal review in Stage B Item 1.)*

---

### Phase 8 — Hardening, Zero-Impersonation Operations, SLOs & Release Dossier
- **Frontend Tab:** `Operations & Support (B8)` (`OperationsTab.tsx`)
- **Playbook Package:** `B8` (Hardening, SLOs, Recovery, Independent Challenge, Release Dossier)
- **What It Does in the Frontend:**
  - **Zero-Impersonation Support Session:** Support operators authenticate with `SUPPORT_AUTH_SECRET` (`POST /api/v2/auth/support-token`) and can view anonymized latency telemetry (`READ` / `WRITE` / `RELEASED_ANALYTICS`), queue depths, kill switches, and **tenant-minted diagnostic receipts**—never customer names, workforce payloads, or impersonated tenant tokens (`authenticate` rejects support tokens with `401`).
  - **Live B8 SLO & Manifest View:** Compares observed API latency against `ops/slo-manifest.v1.yaml` budgets (`<= 500ms` reads, `<= 800ms` writes, `<= 1500ms` releases, `RPO <= 15m`, `RTO <= 4h`), explicitly labeling whether numbers are `CI_INDICATIVE` sandbox/runner measurements vs. `FIXED_ENV_MEASURED` live Postgres evidence.
  - **Release Evidence Dossier Viewer:** Shows real-time gate status (`READY FOR REVIEW` vs `RATIFIED`), commit SHA, 10 backend suites, 30-day HTTP simulation, restore drill metrics, and kill-switch drill results.
- **Why We Are Using It (The Reason):**
  - Production design partners require proof under load (`20` tenants, `1,500` principals, `400,000` facts/week, `150` concurrent requests), rehearsed backup/restore without deleted-data resurrection, support tooling that cannot spy on tenants, and human sign-off bound cryptographically to the exact code commit and container image digests.

---

## 5. Quick Summary: How Everything Connects (Frontend -> API -> Backend -> DB)

```text
Browser UI (React 19 + Vite, 14 Tabs & /demo Console)
  |  Zero local privacy math, zero DB secrets, zero permission guessing
  |  Same-origin /api/v2/* fetch + Bearer JWT + Idempotency-Key + If-Match
  v
Express API Gateway (backend/src/index.ts + telemetry.ts)
  |  Adds X-Request-Id + Cache-Control: no-store
  |  authenticate(JWT) -> resolveActor(at: Date) -> Zod .strict() validation
  v
Domain Command Pipeline (backend/src/platform/command.ts: runCommand)
  |  Opens PostgreSQL transaction via withTenant(tenantId): set_config('app.tenant_id', ..., true)
  |  1 transaction = Business Write + idempotency_record + audit_event + outbox_event
  v
PostgreSQL 16.2 (Forced RLS, Non-Owner Roles) + Worker Daemon (FOR UPDATE SKIP LOCKED)
  |  abate_app / abate_protected_compute / abate_release_compiler / abate_performance / abate_worker
  +--> SigV4 S3 Object Storage (content-addressed evidence artifacts by SHA-256)
```

---

## 6. How to Run Frontend, Backend & Verification Tests

1. **Start Databases (Optional locally; mandatory with `ABATE_REQUIRE_PG=1`):**
   ```powershell
   docker compose up -d postgres objectstore
   npm --prefix backend run migrate
   npm --prefix backend run seed-demo -- --pg
   ```
2. **Start Backend API (`http://localhost:5000`) & Worker (separate terminals):**
   ```powershell
   npm --prefix backend run dev
   npm --prefix backend run worker
   ```
3. **Start Frontend (`http://localhost:5173` & `/demo`):**
   ```powershell
   npm --prefix frontend run dev
   ```
4. **Verify Code Quality, Typechecks & Evidence:**
   ```powershell
   npm --prefix backend run build
   npm --prefix backend run build-dossier
   npm --prefix frontend run lint
   npm --prefix frontend run build
   npm --prefix tests run typecheck
   ```
5. **Run Browser E2E & Accessibility Suite (against running backend + frontend):**
   ```powershell
   npm --prefix tests run test:e2e
   ```
