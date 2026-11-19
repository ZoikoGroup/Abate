# Zoiko Abate: Complete Definition, 12-Step Demo Walkthrough & Phase-by-Phase Guide (Phases 0–8 & Pilot Readiness)

> **Purpose of this Guide:** Prepared for live stakeholder demonstrations of **Zoiko Abate**. Covers what Abate is and why it exists, how to present the **12-Step Live Demo Console (`/demo`)**, a complete breakdown of every architectural phase (**Phase 0 through Phase 8**, plus the **UK Legal Sector Pack** and **Stage B / Pilot Readiness**), and transparent reporting of synthetic (`memDb`) vs. live PostgreSQL verification status.

---

## 1. What Is Zoiko Abate & Why Are We Using It?

### Definition
**Zoiko Abate** (`ZAB-ENG-001`) is an organizational **work-design and psychosocial-risk governance platform** built for high-intensity professional services (starting with UK legal practices aligned to SRA Workplace Culture Guidance, HSWA 1974 §2, and ISO 45003:2021).

> **Core Constitutional Motto:** *"Change the work. Not the worker."*

### Why Traditional Workplace Analytics Fail (The Problem Abate Solves)
Most workplace analytics or "wellbeing" tools fail organizations and employees in three ways:
1. **Surveillance & Privacy Abuse:** Collecting screenshots, keystrokes, app titles, message sentiment, or clinical data creates legal liability and destroys workforce trust.
2. **Individual Scoring disguised as Analytics:** Letting managers drill down into cohorts of 3–4 people or race overlapping queries allows re-identification of individuals for punitive performance reviews.
3. **Unverifiable Assurance:** Claiming "we fixed burnout" because throughput went up, or approving controls and editing them afterward without audit receipts, leaves legal duties unproven.

### How Abate Enforces Boundaries by Architecture (Not Just Policy)
Instead of relying on employee promises or frontend toggles, Abate compiles **six non-negotiable architectural invariants** into schemas, database triggers, role grants, and state machines:
1. **No Individual Scoring:** Zero personal productivity, resilience, employability, or burnout scores.
2. **Physical Minimization (No Surveillance):** Zod `.strict()` schemas drop/reject `screenshotUrl`, `keystroke_tracker`, `sickReason`, `windowTitle`, `privilegedAdvice`, `billingRate`, `individualLawyerRanking`, and calendar titles/attendees at the HTTP boundary—leaving **0 bytes** in database rows, receipts, audit logs, and error logs.
3. **No Clinical Path in v1.0:** Strictly organizational work-design governance (`ZAB-ARCH-001`), never medical diagnosis or therapeutic screening.
4. **Zero Model Training on Workforce Data:** No raw employee data leaves the trust perimeter; AI never reads uncompiled telemetry.
5. **Deterministic Privacy Release Gate (`n >= 10`):** Aggregate metrics (`BOUNDARY_INTRUSION_SHARE`) compile only if distinct contributors `>= 10`, observation window `>= 28` days, symmetric difference `>= 5` against any previously released cohort, and parent/child subset residual `>= 5`—all serialized per tenant via PostgreSQL advisory lock (`pg_advisory_xact_lock`). Suppressed queries return uniform `status: "UNAVAILABLE"` with zero contributor counts leaked. *(Deterministic suppression thresholds are active pending Privacy Owner sign-off on whether to retain deterministic gates or introduce calibrated noise; `"differential privacy"` is excluded from UI/docs.)*
6. **Two-Plane Authority Separation (Plane A vs. Plane B):**
   - **Plane A (Risk & Legal Duty Assurance):** Hazards -> Organizational Causes -> Version-Bound Controls -> Approvals -> Implementation Receipts -> Pre-Pinned Verifications -> Cryptographic Evidence Packages.
   - **Plane B (Work-Design Outcomes):** Operational sustainability/rework/fragmentation evaluations behind feature flags and prohibited-claim filters.
   - **Hard Perimeter:** Plane B metrics **can never close, modify, or substitute for a Plane A hazard obligation** (enforced in both TypeScript domain logic and database triggers).

---

## 2. Live Demo Runtime Transparency (Important for Presenters)

* **Local Workstation vs. PostgreSQL Parity:** When running on a local Windows workstation without PostgreSQL running on port `5432` (for example in an isolated local demo where `ABATE_REQUIRE_PG` is not enabled), the backend boots in **`memDb` (in-memory parity engine)** mode—reflected explicitly in `GET /api/health` (`"database": { "mode": "memory", "required": false, "ok": false }`).
* **Real PostgreSQL Hardening:** Migrations (`backend/db/migrations/`), `FORCE ROW LEVEL SECURITY`, non-owner roles (`abate_app`, `abate_worker`, `abate_migrator`), SQL triggers (`work_fact_purge_guard`, `assert_plane_a`), and `ABATE_REQUIRE_PG=1` fail-closed guards live in the PostgreSQL runtime and run in Postgres-backed environments and CI (`postgres:16.2-alpine`).
* **Evidence Honesty:** Synthetic test suites (`test-boundaries`, `test-worker`, etc.) verify architectural and API contracts against synthetic fixtures. Measured RTO/RPO and production latency SLOs remain `PENDING_MEASURED_EVIDENCE` in `ops/slo-manifest.v1.yaml` until timed backup/restore and HTTP load runs execute against a dedicated fixed PostgreSQL host.

---

## 3. Guided Live Demo Console (`/demo`): All 12 Steps Explained

The **Live Demo Console** presents real HTTP traffic against the backend, with a **Wire Traffic & Audit Inspector** (request headers/body, masked `Authorization: Bearer` tokens, response JSON, cURL generator), **What Happened Behind the Scenes**, and live **Proof Badges**.

### Step 1: Check Backend (`GET /api/health` + `GET /api/info`)
* **What We Show:** Health check and registered domain inventory (12 core domains + sector extensions).
* **Why We Use This:** Proves the browser is speaking to the live Express API server and surfaces the real storage mode (`memory` vs. `postgres`) and constitutional boundaries transparently—no mock banners.
* **Expected Outcome:** `200 OK`, `"status": "ok"`, domain inventory loaded.

### Step 2: Show Contract (`GET /api/v2/contracts/openapi.json`)
* **What We Show:** Live OpenAPI 3.1 contract specification served directly from the running backend (`106` documented paths).
* **Why We Use This:** Code-first API governance ensures frontend clients, backend validators, and daily automated drift checks (`check:endpoints`) share a single authoritative contract.
* **Expected Outcome:** `200 OK`, `openapi: "3.1.0"`, endpoint table populated cleanly.

### Step 3: Sign In as Tenant A (`POST /api/v2/auth/token`)
* **What We Show:** Issues a scoped JWT for **Apex Legal Partners (Tenant A)** (`RISK_OWNER` role, `purpose: "WORKPLACE_RISK_ASSESSMENT"`), with option to inspect **Beacon Chambers (Tenant B)** as well.
* **Why We Use This:** Every subsequent request carries cryptographically bound `tenantId`, `subject`, `role`, and `purpose` claims (in pilot/production, dev token endpoints are disabled and replaced by OIDC PKCE + RS256 JWKS `HttpOnly` cookie sessions).
* **Expected Outcome:** `200 OK`, JWT issued (masked in Wire Inspector cURL), decoded `tenantId` matches Tenant A.

### Step 4: Create Organization (`POST /api/v2/organizations` — The Atomic 4-Way Write)
* **What We Show:** Submits a new organization unit with a unique `Idempotency-Key` header.
* **Why We Use This:** Demonstrates the core **`runCommand` pipeline**. Rather than risking partial writes or missed audit trails, the backend commits **4 database writes in one atomic transaction**:
  1. `organization` — creates the tenant-scoped organizational unit.
  2. `idempotency_record` — claims `(tenant_id, idempotency_key)` bound to the canonical SHA-256 hash of the request payload.
  3. `audit_event` — appends an immutable `INSERT`-only audit record (`UPDATE`/`DELETE` revoked from `abate_app`).
  4. `outbox_event` — stages a transactional outbox message so background workers deliver downstream notifications at-least-once without pre-commit side-effects.
* **Expected Outcome:** `200 OK` (or `201 Created`), UUID returned.

### Step 5: Resend Same Request (`POST /api/v2/organizations` — Replay)
* **What We Show:** Re-sends the **exact same payload** and **exact same `Idempotency-Key`** from Step 4.
* **Why We Use This:** Real networks time out and clients retry. Instead of creating duplicate organizations, Abate recognizes the `(key, request_hash)` match and short-circuits, returning the exact original record (`matching.length === 1`).
* **Expected Outcome:** `200 OK`, identical organization ID returned, zero duplicate rows created.

### Step 6: Change Body, Same Key (`POST /api/v2/organizations` — Expected: 409)
* **Expected Refusal Notice:** **`Expected: 409`** — *"The backend refused this on purpose."* (Displayed with a non-error blue badge.)
* **What We Show:** Reuses Step 4's `Idempotency-Key` while mutating the request body to `"Tampered Organization Name"`.
* **Why We Use This:** Prevents payload substitution and silent last-write-wins overwrites. The backend compares canonical SHA-256 request hashes, detects the mismatch, and aborts before mutating state.
* **Expected Outcome:** Real HTTP **`409 Conflict`** (`code: "CONFLICT"`), Proof Result **`PASS`**.

### Step 7: Skip the Key (`POST /api/v2/organizations` — Expected: 400)
* **Expected Refusal Notice:** **`Expected: 400`** — *"The backend refused this on purpose."* (Displayed with a non-error blue badge.)
* **What We Use This:** Sends a state-changing `POST` **without** an `Idempotency-Key` header.
* **Why We Use This:** Fail-closed reliability guarantee: every mutating command MUST carry an explicit idempotency key; keyless mutations are rejected at the perimeter before reaching domain logic.
* **Expected Outcome:** Real HTTP **`400 Bad Request`** (`code: "VALIDATION"`), Proof Result **`PASS`**.

### Step 8: Switch to Tenant B (`GET /api/v2/organizations` — Row-Level Security Isolation)
* **What We Show:** Authenticates as **Beacon Chambers (Tenant B)** and queries `/api/v2/organizations`, comparing results side-by-side against Tenant A.
* **Why We Use This:** Proves multi-tenant boundary enforcement: Tenant B sees zero organizations belonging to Tenant A (and direct lookup by foreign UUID returns opaque `404 NOT_FOUND` so existence itself never leaks).
* **Expected Outcome:** `200 OK`, `0` leaked Tenant A rows in Tenant B's list.

### Step 9: Test Evidence (`GET /test-report.json`)
* **What We Show:** Loads the live artifact generated by `npm --prefix backend run test-boundaries`.
* **Why We Use This:** Shows audiences that invariants are backed by real automated boundary/isolation tests (`57/57` passing) rather than hardcoded UI claims. Note: computed dynamically—never falls back to fake passing counts if missing or failing.
* **Expected Outcome:** `200 OK`, all `57` tests passed, `0` failed.

### Step 10: Platform Release Dossier (`GET /api/v2/release/dossier`)
* **What We Show:** Loads the cryptographically bound Release Evidence Dossier and Phase 0–8 delivery architecture matrix.
* **Why We Use This:** Summarizes verified suites (`12` suites, `156` checks across synthetic runs), `0` open P0 defects, dossier SHA-256 hash, and governance status (`READY FOR REVIEW` until signed by a named release authority via `sign-dossier.ts`).
* **Expected Outcome:** `200 OK`, verified suites & `P0 = 0` check clear.

### Step 11: Create Secondary Division (`POST /api/v2/organizations` — Extra)
* **What We Show:** Creates `"Dispute Resolution & Advisory Division"` using a **fresh** unique `Idempotency-Key`.
* **Why We Use This:** Demonstrates repeatable forward progress after intentional Step 6/7 refusals—confirming the pipeline remains healthy and ready for legitimate writes.
* **Expected Outcome:** `200 OK` / `201 Created`, new division UUID generated.

### Step 12: Verify Organization Record (`GET /api/v2/organizations/:id`) & Summary Matrix
* **What We Show:** Reads back the authoritative organization record by ID for Tenant A and automatically opens the **Demo Audit Verification Summary** modal summarizing all 12 real HTTP calls, status codes (with blue `Expected: 409` and `Expected: 400` badges), proof outcomes, and wire latencies.
* **Expected Outcome:** `200 OK`, authoritative read matches Step 4 creation, `12/12` steps `PASS`.

---

## 4. Detailed Phase-by-Phase Guide (Phases 0 through 8 + Sector & Pilot)

### Phase 0: Architectural Foundations, Multi-Tenancy & Reliability Infrastructure
* **Scope / Domains:** `S01`, DB Migrations (`0001–0082`), `withTenant()`, Outbox/Worker, Append-Only Audit.
* **What It Delivers:**
  * Every tenant request executes inside `withTenant(tenantId, fn)` which sets transaction-local `app.tenant_id` (`set_config(..., true)`) so pooled connections never leak tenant state across requests.
  * Three dedicated Postgres roles: `abate_migrator` (DDL only), `abate_app` (`NOSUPERUSER NOBYPASSRLS`, subject to `FORCE ROW LEVEL SECURITY`, `UPDATE`/`DELETE` revoked on `audit_event`), and `abate_worker` (`REVOKE ALL` on `identity_map`, privacy ledgers, and snapshots).
  * **Transactional Outbox + Worker Daemon (`backend/src/worker/daemon.ts`):** `FOR UPDATE SKIP LOCKED` draining, consumer `inbox_event` idempotency deduplication, crash-recovery without duplicate effects, and reference-only dead-letter queue after 5 failed attempts.
* **Where to See It in UI:** `Tenant Isolation & Attack Lab`, `Transactional Outbox`, `Append-Only Audit Trail`, `Constitutional Invariants`.

### Phase 1: Identity, Authorization & Idempotent Command Pipeline
* **Scope / Domains:** `S01` Identity & Auth, `runCommand` pipeline, OpenAPI Contract Registry.
* **What It Delivers:**
  * Authenticated principal binding (`tenantId`, `subject`, `role`, `purpose`) across roles (`RISK_OWNER`, `CONTROL_OWNER`, `REVIEWER`, `WORKS_COUNCIL`, `EMPLOYER_ADMIN`, `OPS_ADMIN`).
  * `POST /api/v2/organizations` validates strictly with Zod, requires `Idempotency-Key`, stores canonical request hashes, deduplicates identical replays (`200`), and blocks tampered key reuse (`409 Conflict`).
* **Where to See It in UI:** Navbar role/tenant switcher, `Organizations & Idempotency` tab, `Live Demo Console` Steps 3–7.

### Phase 2: Ingestion Pipeline & Append-Only Work-State Ledger
* **Scope / Domains:** `S02` (Source Contracts & Connectors), `S03` (Append-Only Work-State Ledger).
* **What It Delivers:**
  * **Explicit Source Contracts:** Connections (`ZoikoTime`, `CalendarCadence`) bind to immutable contract hashes and cadences; state transitions (`ACTIVE`, `PAUSED`, `REVOKED`) block unapproved sources (`403 Forbidden`).
  * **Physical Minimization Decoy Gate:** Unallowlisted fields (`screenshotUrl`, `sickReason`, `windowTitle`, `attendees`, `eventTitle`) fail schema parsing immediately (`400`)—0 bytes quarantined or logged.
  * **Tenant-Salted HMAC Pseudonymization:** Converts raw `subjectRef` to `subject_pseudonym` at ingest; plaintext mapping sits strictly isolated in `identity_map` (inaccessible to `abate_worker`).
  * **Freshness & Anti-Silence Rule:** Connection lag `> 3x` expected cadence marks health `STALE`. Missing data means *unknown risk*, never *zero workload*.
  * **Revision Immutability:** Appending `revision = 2` adds a new ledger row while keeping `revision = 1` intact for full forensic traceability.
* **Where to See It in UI:** `Ingestion & Work Ledger (Phase 2)` tab (`Send Clean Batch`, `Send Duplicate Replay`, `Send Surveillance Decoy`, `Send Revision 2`, `Register Connection`, `Pause`/`Resume`/`Revoke`).

### Phase 3: Deterministic Cohort Measurement & Privacy Release Compiler
* **Scope / Domains:** `S04` (Deterministic Metric Engine), `S06` (Privacy Release Compiler & Single Read Path).
* **What It Delivers:**
  * **Deterministic Interval Math:** Uses half-open UTC intervals (`[start_at, end_at)`) merged by interval union to prevent double-counting overlapping time blocks; `CalendarCadence` blocks are excluded from `kind = 'WORK'` work hours (`compile-release.ts`). Zero denominator yields `NOT_APPLICABLE`.
  * **Four Privacy Suppression Gates (`DEFAULT_PRIVACY_PROFILE`):**
    1. Contributor Floor: distinct eligible contributors `n >= 10` (`n = 9` returns `UNAVAILABLE`).
    2. Minimum Observation Window: Class B releases require `>= 28` days.
    3. Overlap Differencing Guard: symmetric difference `>= 5` vs. any previously disclosed cohort (`n=10` off-by-1 query blocked).
    4. Parent/Child Residual Guard: subset residual `>= 5` (`parent=14, child=10 -> residual=4` blocked).
  * **Serialized Concurrency Lock & Single Read Path:** Concurrent requests lock on `disclosure:<tenantId>` so two racers cannot slip under `overlapMin`. `released_artifact` omits `contributor_count` and member lists completely.
  * **Recalculation Staleness:** Updating a metric definition marks dependent releases `SUPERSEDED / STALE` cleanly.
* **Where to See It in UI:** `Cohort Analytics & Privacy (Phase 3)` tab (all 4 Adversarial Lab attacks, Semantic Query, CSV export, Trigger Recalculation).

### Phase 4: Psychosocial Hazard Control Cycle & Cryptographic Evidence Packages
* **Scope / Domains:** `S05` (Hazard Governance), `S07` (Control State Machine & Verification), `BE-007`.
* **What It Delivers:**
  * **7-Step Plane A Chain:** `Hazard (anchored to originating privacy release)` -> `Organizational Cause (reviewed & accepted—no blaming individuals)` -> `Control Intervention` -> `Version-Bound Approval` -> `Attributable Implementation Receipt (MANUAL | INTEGRATED)` -> `Pre-Pinned Verification Plan` -> `Human Reviewer Conclusion & Hazard Disposition`.
  * **Invariant Refusals:**
    * Direct skip `PROPOSED -> IMPLEMENTING` refuses with `409 Conflict`.
    * ***"v4 Cannot Approve v5":*** Any material edit (`PATCH /api/v2/controls/:id`) bumps version, recomputes `material_hash`, resets approval to `APPROVAL_REQUIRED`, and rejects stale `If-Match` tokens with `409 Conflict`.
    * **Transfer-of-Risk Guard:** Evaluates whether improving the target cohort pushed work onto an adjacent group (`> 5%` tolerance), blocking an automatic `EFFECTIVE` claim *(shown as labeled client Simulation in Lab Button 3 while real pin/conclude runs on controls)*.
  * **Evidence Export:** Bundles hazard, causes, approvals, implementation receipts, verification, and release artifact with canonical SHA-256 leaf hashes and Merkle root.
* **Where to See It in UI:** `Hazards & Controls (Phase 4)` tab + embedded `AiPanel`.

### Phase 5: Multi-Jurisdiction Policy, Data Retention, Legal Holds & GDPR Erasure
* **Scope / Domains:** `S11` (Jurisdiction Coverage), `S12` (Retention Schedules, Legal Holds, Tombstones & Rights Requests), `B5`.
* **What It Delivers:**
  * **Effective-Dated Jurisdiction Packs (`[effective_from, effective_to)`):** Read-only published policy packs govern legal floor/ceiling retention bounds per tenant (`GET /api/v2/jurisdiction/coverage`). Outside coverage or conflicting bounds fail closed—never falling back to an invented default duration!
  * **Tenant Retention Class Scheduling:** Cannot execute deletions until explicitly configured (`NO_POLICY` deletes `0` rows); refuses durations violating pack floors/ceilings.
  * **Legal Preservation Holds:** Holds (`ALL` or per `connectionId`) override expiry; `eligible = purged + held`. Releasing twice returns `409 Conflict`.
  * **Verified Tombstones & Anti-Resurrection:** Before `work_fact_revision` deletes, a content-free SHA-256 `deletion_tombstone` is written, verified post-delete, and enforced by Postgres trigger (`work_fact_purge_guard`). Re-ingesting a purged source record increments `duplicate` instead of resurrecting deleted history.
  * **Authority Separation:** `MEMBER` and `CONTROL_OWNER` roles receive `403 FORBIDDEN` if attempting holds or purges.
* **Where to See It in UI:** `Retention & Legal Hold (Phase 5)` tab.

### Phase 6: Bounded AI Assistance & Safe External Action Execution
* **Scope / Domains:** `S08` (Bounded AI Proposal Gateway), `S09` (Signed Action Broker & Lease Fencing), `BE-008`.
* **What It Delivers:**
  * **AI Is Strictly Draft-Only:** Explanations and candidate cause/control drafts save as `PROPOSED`; human reviewers explicitly **Accept** (registering a manual proposal) or **Discard**. Every core workflow completes with AI switched completely OFF.
  * **4 Deterministic AI Safety Guards:**
    1. **Prompt Injection Defense:** Neutralizes injected instructions attempting data exfiltration.
    2. **Citation Fabrication Blocker:** Rejects unretrieved/hallucinated release references (`CITATION`).
    3. **Numeric Fidelity Validator:** Blocks output altering aggregate release figures (`31.0%` vs real `23.4%` -> `NUMERIC_FIDELITY`).
    4. **Individual Inference Pre-Check:** Refuses `"who is most at risk?"` queries (`400`/`403`) **before** calling any model.
  * **Safe External Actions (`S09`):**
    * Requires live, non-stale control approval (`SEEDED_APPROVAL_ID` / valid approval matching current version).
    * Issues a signed grant bound to `tenantId`, `attemptId`, and canonical **parameter SHA-256 hash**—mutating parameters after approval fails (`MUTATED_ACTION` -> `403 FORBIDDEN`).
    * Ambiguous provider timeouts move cleanly to `UNKNOWN_OUTCOME` for reconciliation rather than risky blind retries.
    * Worker leases enforce fencing tokens so slow/stale workers cannot overwrite newer state.
  * **Multi-Scope Emergency Kill Switches:** Global (`all_ai`), per use-case (`use_case:explain_release`), per tool (`tool:ticket_notification`), per connector (`connector:zoikotime`), and release/pack scopes fail closed (`503`) immediately via support operator credentials without disrupting manual Plane A workflows.
* **Where to See It in UI:** `Bounded AI & Actions (Phase 6)` tab + inline `AiPanel`.

### Phase 7: Two-Plane Work-Design Outcomes & Governed AI Change
* **Scope / Domains:** `S13` (Plane B Outcome Evaluations), `S14` (8-Stage AI Work-Design Change Lifecycle), `B7`.
* **What It Delivers:**
  * **Feature-Flagged Plane B Isolation (`outcomes_plane_b`):** Records cohort operational outcomes (`WORKLOAD_SUSTAINABILITY`, `ROLE_CLARITY`, `FRAGMENTATION_INDEX`, `AI_REWORK_RATE`) inside explicit `writePlane: "B"` contexts.
  * **Immutable `outcome_class` & Prohibited Claim Filter:** Evaluates outcomes strictly for operational claims—any claim asserting employee stress reduction, resilience grading, or hazard mitigation fails closed with `400 VALIDATION`.
  * **Cross-Plane Non-Interference:** `GET /api/v2/outcomes/releases/:id` hides Plane B from Plane A readers; Plane B writes trigger `403 FORBIDDEN` if touching hazard dispositions or approvals.
  * **8-Stage AI Rollout Assessment (`S14`):** `REGISTERED -> BASELINE -> DETECT -> ATTRIBUTE -> CONTROL -> VERIFY -> PERFORMANCE_REVIEW -> CLOSED`. Optimistic concurrency via `If-Match` version header and strict stage guards block premature closure (`409 Conflict`) whenever prerequisites or hazards remain unresolved.
* **Where to See It in UI:** `Outcomes & AI Change (Phase 7)` tab.

### Sector Packs (Legal launched; Healthcare and Software & IT in preview)
* **Scope / Domain:** sector pack registry in `backend/src/domains/lifecycle/sector-registry.ts`, packs in `backend/src/domains/lifecycle/packs/`, generic endpoints in `backend/src/routes/sector-work.ts`. Any sector is a data definition, see ADR-006. The legal pack is `legal-uk-sra` (SRA 2023 Workplace Culture / HSWA 1974 §2 / ISO 45003). Healthcare and Software & IT are previews: selectable, not claimed as launched, regulatory content pending the Legal & Policy Lead.
* **How to demo another sector:** `Organizations` tab -> `Sector Pack` card -> pick a sector -> `Apply Sector Pack`. The sector tab, vocabulary, demand windows and forbidden fields change with no code change.
* **What It Delivers:**
  * **Domain-Neutral Translation (`WORK_ITEM`):** Maps legal matters (`COMMERCIAL_LITIGATION`, `CORPORATE_MA`, `REGULATORY_INVESTIGATION`, `ARBITRATION`) and court/closing demand windows (`TRIAL_PREP`, `CLOSING_TRANSACTION`) into domain-neutral intervals while rejecting `privilegedAdvice`, `billingRate`, and `individualLawyerRanking` (`400`).
  * **Trial Window Fatigue Surge Detection:** Flags sustained unbuffered drafting (`>= 3` consecutive sessions past `20:00 UTC`) to trigger SRA-aligned supervisory partner review *(note: in UI, the partner sign-off preview button is labeled `Simulation` while fatigue check & boundary mapping execute against real backend endpoints)*.
* **Where to See It in UI:** the sector tab (titled by the active pack, for example `Legal Sector Pack (SRA 2023)`) + the sector work item panel in `Hazards & Controls`.

### Phase 8: Operations, Zero-Impersonation Support, Merkle Verifier & Release Dossier
* **Scope / Domains:** `B8` Operations, Audit Verifier (`WebCrypto`), `build-dossier.ts` / `sign-dossier.ts`.
* **What It Delivers:**
  * **Zero-Impersonation Support Architecture:** Support operators use dedicated support credentials (`POST /api/v2/auth/support-token` in dev; OIDC operator claims in pilot) that are strictly refused (`403`) on all tenant data routes; tenant tokens are likewise refused on `/api/v2/ops/*`.
  * **Tenant Self-Issued Diagnostic Receipts:** Tenants generate signed state/count snapshots excluding PII, work facts, and contributor counts; support verifies authenticity cryptographically without database access.
  * **SLO Monitoring & Safe Error Logs:** Live nearest-rank p95 latency/availability per route class (`auth`, `ordinaryReads`, `stateMutations`, `analyticsReleased`) and fingerprinted internal errors keyed by `requestId` (never stack traces or payloads). *(Static Disaster Recovery `8 ms` and 150-concurrency tables are labeled `Simulation` baseline references beside live telemetry.)*
  * **Browser Offline Merkle & Hash Verifier:** Pure WebCrypto verifier (`SHA-256` canonical leaf + `abate.merkle.v1` tree proof + `manifestHash`) that proves tampering vs. integrity—with explicit **Epistemic Boundary Notice**: *"Hashes prove files are unchanged since export, NOT that claims are true."*
  * **Commit-Bound Release Evidence Dossier:** Aggregates test suite reports, defect counts (`p0FailedSuites: 0`), recovery rehearsal scripts, and kill-switch drills into `release-dossier.json`, invalidating any stale sign-off whenever `commitSha`, `dossierHash`, or image digests change.
* **Where to See It in UI:** `Operations & Support (B8)` and `Audit Verifier & Merkle` tabs.

### Final Phase: Stage B Governance & Pilot Readiness (`B9`)
* **Open Human Sign-Offs (`docs/governance/open-signoffs.md` & ADRs 001–005 — Currently DRAFT):**
  1. **Privacy Owner:** Ratify deterministic suppression (`10 / 28d / 5 / 5`) vs. calibrated noise spec.
  2. **BE-001 to BE-010 Spec Holder:** Review `be-spec-reconciliation.md` & `ADR-001` through `ADR-005`.
  3. **Legal & Policy Reviewer:** Approve SRA-aligned framing and replace synthetic retention durations.
  4. **Named Release Authority:** Execute human cryptographic sign-off via `tools/sign-dossier.ts` bound to commit SHA and image digests.
* **Pilot Readiness Runtime (`test-pilot` — 5/5 Automated Gates Verified):**
  * **Secrets Manager Hydration:** Loads secrets via `ABATE_SECRETS_FILE` / `ABATE_SECRETS_DIR`, failing closed on production/staging defaults.
  * **Dev Token Lockdown:** `/auth/token`, `/auth/refresh`, `/auth/support-token` return `404` when dev tokens are disabled outside local/test.
  * **OIDC PKCE + RS256 JWKS Session Exchange:** `HttpOnly` cookie session flow + key rotation + non-tenant operator enforcement.
  * **Monitoring & S3 ObjectStore Health:** Prometheus `/metrics`, `/api/v2/ops/alerts`, and SigV4-signed `ObjectStore` (`putVerified` / `readVerified`) integrity.
* **Measured PostgreSQL Evidence Requirement:** Dedicated fixed machine runs (`test-load:http` and `measure-restore`) are required to transition `ops/slo-manifest.v1.yaml` from `PENDING_MEASURED_EVIDENCE` to signed production SLO targets.
