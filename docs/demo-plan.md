# Zoiko Abate: Live Demo Console Architecture & Plan

This document defines the architectural blueprint and operational UX for the **Live Demo Console** in Zoiko Abate. The console guides evaluators, executives, and technical auditors step-by-step through the real, unmocked backend verification suite for Phase 0 (Foundation) and Phase 1 (Tenancy, Identity, Isolation, Idempotency, and Audit).

---

## 1. High-Level Page Layout

The Live Demo Console follows a split-screen, high-density executive console layout:

```
+-----------------------------------------------------------------------------------------------------+
| [ZOIKO ABATE]  • Live Demo Console • [Run All Steps] [Reset Demo] [Progress: 4/10] [Shortcuts: N/P] |
+-------------------------------+---------------------------------------------------------------------+
| STEPPER (Left 280px)          | MAIN CONSOLE (Right Flex)                                           |
|                               |                                                                     |
| 1. Check Backend           ✓  | [WHAT WE'RE SHOWING]                                                |
| 2. Show Contract           ✓  | "This is the running backend, not a mock."                          |
| 3. Sign In (Tenant A)      ✓  |                                                                     |
| 4. Create Organization   -->  | [ACTION & CONTROLS]                                                 |
| 5. Resend Same Request        | [Create Organization] [Copy as cURL]                                |
| 6. Alter Body, Same Key       |                                                                     |
| 7. Skip Idempotency Key       | [PROOF BADGE: PASS / FAIL]                                          |
| 8. Tenant B Isolation         | ✔ PROOF: Idempotency, audit & outbox committed in single tx         |
| 9. Test Evidence Suite        |                                                                     |
| 10. Roadmap (Phases 2-8)      | [REQUEST INSPECTOR]                                                 |
|                               | - Method, URL, Elapsed ms, X-Request-Id                             |
|                               | - Headers (masked auth token, Idempotency-Key)                      |
|                               | - Payload & Pretty JSON Response                                    |
|                               |                                                                     |
|                               | [WHAT JUST HAPPENED (Behind the Scenes)]                            |
|                               | "Backend wrote 4 things atomically..."                              |
|                               |                                                                     |
|                               | [ < Previous Step ]                             [ Next Step > ]     |
+-------------------------------+---------------------------------------------------------------------+
```

### Brand Tokens Applied:
* **Aubergine**: `#2B1B38` (Primary brand, headers, active step badges)
* **Coral**: `#E26D5A` (Accent, proof highlights, action buttons)
* **Graphite**: `#2F343A` (Text, borders, code backgrounds)
* **Sage**: `#8D9A96` (Muted indicators, timestamps, labels)
* **Ivory**: `#F6F4EF` (Background, light container surfaces)
* **Emerald**: `#059669` / `#10B981` (PASS proof badges)
* **Rose**: `#E11D48` (FAIL indicators, 409/400 errors)

---

## 2. Component Hierarchy

1. `<LiveDemoConsole />`: Top-level orchestrator holding the 10-step state machine, automated playback loop, keyboard navigation listener, and reset handler.
2. `<StepperNav />`: Accessible vertical stepper listing steps 1 to 10 with completion checks and keyboard navigation (`N` / `P`).
3. `<StepHeader />`: Step title, executive headline ("What we're showing"), and presenter talking-point callout.
4. `<RequestInspector />`: Reusable inspector detailing:
   * Method pill (`GET`, `POST`)
   * Endpoint URL path
   * Latency in milliseconds
   * Response status badge (`200 OK`, `400 Bad Request`, `409 Conflict`)
   * `X-Request-Id` tracking tag
   * Request headers (with `Idempotency-Key` and masked `Authorization`)
   * Request JSON body
   * Formatted response JSON payload
5. `<ProofBadge />`: Pass/Fail badge with cryptographic or semantic proof validation criteria.
6. `<WhatHappened />`: Plain-English narrative explaining the backend database mechanics (e.g. tables mutated, RLS filters applied).
7. `<CurlCopyButton />`: Instant button copying an exact `curl` command reproducing the call directly in terminal.
8. `<DemoSummary />`: Final completion card showing all 10 verified steps with timestamps.

---

## 3. The 10 Guided Demo Steps

### Step 1: Check Backend (Health & System Information)
* **Executive Sentence**: The backend is running live with active constitutional bounds and modular domain routing.
* **Presenter Talking Point**: *"This is the running backend, not a mock."*
* **API Calls**:
  1. `GET /api/health`
  2. `GET /api/info`
* **Pass / Fail Condition**: Status `200 OK` on both endpoints, `status: 'ok'`, and `constitutionalBoundaries` present.
* **What Just Happened**: Probes live service health, verifies environment, and confirms constitutional boundaries (zero individual surveillance, zero clinical dependency).

---

### Step 2: Show Canonical API Contract (OpenAPI 3.1)
* **Executive Sentence**: The authoritative contract registry provides single-source-of-truth definitions for all client interactions.
* **Presenter Talking Point**: *"The frontend is generated from this contract."*
* **API Call**: `GET /api/v2/contracts/openapi.json`
* **Pass / Fail Condition**: Status `200 OK`, `openapi: '3.1.0'`, and paths contain `/auth/token`, `/organizations`, and `/health`.
* **What Just Happened**: Fetches the complete OpenAPI 3.1 specification declaring all routes, schemas, and security definitions.

---

### Step 3: Authenticate as Tenant A (Identity Derivation)
* **Executive Sentence**: Identity provides tenant scoping securely via signed JWT claims, never from request body parameters.
* **Presenter Talking Point**: *"The tenant comes from the token."*
* **API Call**: `POST /api/v2/auth/token` with payload:
  ```json
  {
    "tenantId": "00000000-0000-4000-a000-00000000000a",
    "subject": "auth0|user-tenant-a-risk-owner",
    "role": "RISK_OWNER",
    "purpose": "WORKPLACE_RISK_ASSESSMENT"
  }
  ```
* **Pass / Fail Condition**: Status `200 OK`, `token` is non-empty, and decoded `tenantId` strictly matches Tenant A.
* **What Just Happened**: Issues an 8-hour cryptographic Bearer token binding tenant context and domain role.

---

### Step 4: Create Organization (Atomic 4-Way Invariant)
* **Executive Sentence**: Every state-changing command writes to four database tables atomically in a single transaction.
* **Presenter Talking Point**: *"One click, one key."*
* **API Call**: `POST /api/v2/organizations` with header `Idempotency-Key: <new-uuid>` and body:
  ```json
  { "name": "Corporate Litigation Practice <rand>" }
  ```
* **Pass / Fail Condition**: Status `200 OK`, valid UUID returned, and backend confirms 4 simultaneous table writes:
  1. `organization` (entity created)
  2. `idempotency_record` (key claimed with payload hash)
  3. `audit_event` (immutable audit logged)
  4. `outbox_event` (event staged for asynchronous delivery)
* **What Just Happened**: Executes `runCommand` pipeline, committing the business record, idempotency receipt, audit trail, and outbox event in one atomic Postgres transaction.

---

### Step 5: Resend Same Request (Idempotent Deduplication)
* **Executive Sentence**: Replaying a request with the exact same idempotency key and body produces zero duplicate database records.
* **Presenter Talking Point**: *"Flaky network, still one record."*
* **API Call**: `POST /api/v2/organizations` with the **same** `Idempotency-Key` and **identical** body as Step 4.
* **Pass / Fail Condition**: Status `200 OK`, response body matches Step 4 byte-for-byte, and organization count does not increase.
* **What Just Happened**: The backend detects the existing key with matching payload hash, short-circuits execution, and returns the cached response without creating duplicate entities.

---

### Step 6: Alter Body with Same Key (Tampering Prevention)
* **Executive Sentence**: Attempting to reuse an idempotency key with modified payload content is strictly rejected as a conflict.
* **Presenter Talking Point**: *"Key reuse with different content is refused."*
* **API Call**: `POST /api/v2/organizations` with the **same** `Idempotency-Key` but modified `name: "Tampered Entity"`.
* **Pass / Fail Condition**: Status `409 Conflict` and error code `CONFLICT`.
* **What Just Happened**: Payload hash does not match the claimed idempotency record; backend aborts immediately with 409 CONFLICT to prevent payload substitution attacks.

---

### Step 7: Skip Idempotency Key (Mandatory Reliability Gate)
* **Executive Sentence**: Any state mutation missing the required Idempotency-Key header is rejected fail-closed.
* **Presenter Talking Point**: *"Every change must carry a key."*
* **API Call**: `POST /api/v2/organizations` **without** any `Idempotency-Key` header.
* **Pass / Fail Condition**: Status `400 Bad Request` and error code `VALIDATION`.
* **What Just Happened**: Pre-flight validation gate verifies mandatory headers before invoking domain logic. Missing key halts execution at route boundary.

---

### Step 8: Tenant B Isolation Verification
* **Executive Sentence**: Database Row-Level Security ensures Tenant B cannot read or discover any entities created by Tenant A.
* **Presenter Talking Point**: *"Isolation is enforced in the database."*
* **API Calls**:
  1. `POST /api/v2/auth/token` for Tenant B (`00000000-0000-4000-b000-00000000000b`)
  2. `GET /api/v2/organizations` using Tenant B's token
* **Pass / Fail Condition**: Status `200 OK`, Tenant B's list contains only Tenant B organizations, and contains **zero** Tenant A organizations.
* **What Just Happened**: Queries execute with `app.tenant_id = Tenant B`. Forced RLS policies automatically filter rows at the database engine level.

---

### Step 9: Boundary Test Evidence Suite
* **Executive Sentence**: Formal boundary and isolation tests run under restricted database roles and generate verified test evidence.
* **Presenter Talking Point**: *"Not just UI: the tests prove it."*
* **Action**: Loads and parses `frontend/public/test-report.json` generated by `npm run test-boundaries`.
* **Pass / Fail Condition**: 57 tests passed, 0 failed, with PASS status on every constitutional boundary check.
* **What Just Happened**: Proves that automated tests executed against the PostgreSQL security perimeter passed 100% of adversarial checks.

---

### Step 10: Phase 2-8 Architecture Roadmap
* **Executive Sentence**: Phases 2 through 8 are planned in the architectural roadmap and clearly demarcated as upcoming packages.
* **Presenter Talking Point**: *"Ingestion, privacy and workflow come next."*
* **Display**:
  * Phase 2: Ingestion & Work-State Ledger (S02, S03)
  * Phase 3: Deterministic Measurement & Privacy Release (S04, S06)
  * Phase 4: Hazards, Controls & Verification Workflow (S05, S07)
  * Phase 5: Retention & Multi-Jurisdiction Policy Packs (S11, S12)
  * Phase 6: Bounded AI & Safe Action Execution (S08, S09)
  * Phase 7: Work-Design Outcomes & Governed AI Change (S13, S14)
  * Phase 8: Hardening, SLOs & Zero-Impersonation Diagnostics (B8)
* **Pass / Fail Condition**: Clean architectural status display.

---

## 4. Presenter Features

* **Run All Steps**: Executes steps 1 through 10 sequentially with 800ms delays, scrolling smoothly to each step.
* **Reset Demo**: Re-initializes console state, resets step pointer to 1, and seeds a new unique organization name.
* **Keyboard Navigation**:
  * Press `N` or `ArrowRight` -> Advance to Next Step
  * Press `P` or `ArrowLeft` -> Return to Previous Step
* **Copy as cURL**: Each step provides a one-click button to copy the exact terminal command reproducing the HTTP call.
* **Interactive Summary**: Upon reaching Step 10, provides an executive audit summary badge with timestamps.

