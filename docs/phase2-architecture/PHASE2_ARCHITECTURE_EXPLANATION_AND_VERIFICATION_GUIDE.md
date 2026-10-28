# Zoiko Abate — Phase 2 Architecture: Ingestion & Work-State Ledger
**Document Reference:** ZAB-ENG-001 v1.0 &bull; Package B2 (Domains S02 & S03)  
**Constitutional Philosophy:** *"Change the work. Not the worker."*

---

## 1. What Is This? (Phase 2 Overview)

Phase 2 of Zoiko Abate implements **Domain S02 (Ingestion)** and **Domain S03 (Work-State Ledger)**. 

### The Core Problem Phase 2 Solves
Traditional enterprise software treats worker data carelessly. HR and monitoring tools frequently overcollect invasive surveillance data—such as web browsing histories, desktop screenshots, keystroke rates, and sensitive health/sick leave justifications—and store them in shared databases where they risk being abused for employee tracking and disciplinary micro-management.

Zoiko Abate exists for **workplace psychosocial risk assessment and work redesign** (measuring structural chronic overload, irregular unsocial work intervals, and recovery fragmentation), **never individual employee surveillance**.

Phase 2 establishes the cryptographic and boundary mechanisms that guarantee:
1. **Ingestion without Overcollection:** Raw workforce data from external sources (such as time-tracking systems, calendar providers, and shift schedules) is filtered at the very front gate. Only strictly allowlisted operational intervals are admitted.
2. **Physical Minimization over Policy Promises:** Unapproved fields are dropped immediately. No quarantine database, no error log dump, and no telemetry table ever records forbidden surveillance data.
3. **Tenant-Scoped HMAC Pseudonymization:** Raw individual identifiers (e.g. employee IDs, email addresses, names) are mathematically transformed using HMAC-SHA256 salted by a confidential per-tenant secret before they ever reach the work ledger.
4. **Append-Only Historical Revisions:** The work-state ledger is strictly append-only. Work intervals are never mutated or destroyed. Corrections are recorded as higher revisions (`revision: 2`), enabling full auditability and exact time-travel reconstruction.
5. **Time-Derived Freshness:** Connection health is derived strictly by comparing sync watermarks against wall-clock time and cadence intervals. Missing data over 3 cadences evaluates to `STALE`, ensuring a dead connection is never misinterpreted as "zero work" or "zero risk".
6. **Transactional Outbox Event Emission:** Upon every committed batch, an outbox event (`work.facts.changed`) is saved inside the same atomic database transaction, ensuring downstream risk engines receive dependable notifications without distributed dual-write hazards.

---

## 2. Why Are We Using These Specific Patterns?

Every architectural decision in Phase 2 is grounded in constitutional requirements and engineering threat models:

| Architectural Component | What It Does | Why We Use This Only (Design Justification) |
| :--- | :--- | :--- |
| **Allowlisted Strict Schemas (`ZoikoTimeIntervalV1.strict()`)** | Validates payloads against explicit allowlists and rejects any unknown or extra fields. | Passive schema validation allows extra keys through by default. By enforcing `.strict()` in Zod, the API boundary physically rejects surveillance creep (e.g. `screenshotUrl`, `sickReason`, `windowTitle`) before data touches memory pools or persistence. |
| **Physical Minimization (Decoy Lab)** | Strips rejected data completely and never logs raw input payloads. | Typical microservices dump failed JSON payloads to error logs or "dead-letter queues / quarantine tables" for debugging. That practice accidentally leaks sensitive medical and surveillance data into observability pipelines. In Abate, rejected decoys are discarded silently with 0 database trace. |
| **Tenant-Scoped HMAC Pseudonymization** | Hashes `subject_id` with `crypto.createHmac("sha256", tenantSecret)`. | Global hashing (like standard MD5/SHA256) allows cross-tenant correlation attacks. A tenant-salted HMAC ensures the same employee in Tenant A and Tenant B produces unrelated pseudonym hashes, preventing employee tracking across organizational boundaries. |
| **Append-Only Revision Ledger (`work_fact_revision`)** | Revisions are inserted with unique key `(tenant_id, connection_id, source_record_id, revision)`. `UPDATE` and `DELETE` queries are prohibited. | In workplace risk modeling, retroactive alteration of time records distorts safety audits and compliance records. Maintaining an append-only revision history preserves an immutable timeline of what was known when. |
| **Time-Derived Freshness vs. Count-Based Health** | Health is calculated as `FRESH` ($\le 1\times$ cadence), `DELAYED` ($1\text{--}3\times$ cadence), or `STALE` ($> 3\times$ cadence). | If an API measures source health simply by whether error rates are low or zero records are arriving, a broken or silenced source connector appears "healthy" with 0 recorded hours. Downstream psychosocial risk models would falsely infer "zero workload" and "zero risk". Deriving freshness from wall-clock lag guarantees an outage alerts operators immediately. |
| **Traceable Ingest Receipts** | Stores batch metadata and counts (`accepted`, `duplicate`, `rejected`, `conflicted`). | Provides full mathematical reconciliation for enterprise auditors while upholding data minimization: receipts store proof of processing without persisting the underlying records. |

---

## 3. Why Is Everything Built in Next.js / TypeScript Only?

The entire Abate architecture (frontend, backend, contracts, and test runner) is implemented as a unified **TypeScript / Next.js** solution. This design directly reflects **ADR-000** and modern fullstack enterprise principles:

### 1. End-to-End Type Safety & Shared Zod Contracts
- By utilizing TypeScript across both frontend and backend, the strict schema definition (`ZoikoTimeIntervalV1`, `ZoikoTimeBatchV1`) is declared once.
- There is zero translation layer or schema drift between the client-side form validator, the API request parser, and the database persistence pipeline.
- If a contract field changes, the TypeScript compiler immediately catches mismatches at build time across the entire codebase (`tsc -b`).

### 2. Elimination of Cross-Language Serialization Impedance
- Multi-language architectures (e.g. Python backend + Go worker + React frontend) suffer from JSON serialization discrepancies, date parsing drift, and differing float/integer representations.
- In Abate, ISO 8601 UTC timestamp handling, IANA timezone validation (`Europe/London`), and JSON canonicalization behave identically on the browser and the server.

### 3. Sub-Millisecond In-Process Cryptography
- Pseudonym derivation requires running HMAC-SHA256 for hundreds of work intervals per batch.
- Node.js's built-in `node:crypto` engine executes OpenSSL-accelerated native cryptography in-process, eliminating the network latency and failure modes of third-party external hashing microservices.

### 4. Seamless React 19 & Next.js Architecture
- The frontend uses React 19 with modular UI components designed to operate seamlessly with Next.js App Router (Server Actions and Route Handlers) or standalone Vite proxy dev environments.
- The state management uses native React hooks (`useState`, `useCallback`, `useEffect`) and clean universal fetch clients, keeping bundle size minimal without bloated state-management frameworks.

### 5. Unified Multi-Tenant Security Perimeter
- Both the backend API middleware and database client execute tenant-context wrapping (`withTenant(pool, tenantId, role)`).
- Having a single runtime allows PostgreSQL session settings (`SET LOCAL abate.current_tenant_id`) and JWT claims to be asserted without distributed token-exchange handoffs.

---

## 4. How to Check and Verify Everything (Testing Guide)

Follow these step-by-step instructions to verify every capability of Phase 2.

### Step 1: Automated Verification via the Boundary Test Runner
Open a terminal in the project directory and run the constitutional test runner:

```bash
# From workspace root:
npm --prefix backend run test-boundaries

# Or from inside backend/:
cd backend
npm run test-boundaries
```

#### Expected Output
All 11 tests across Phase 0, Phase 1, and Phase 2 will execute and pass:
```text
=== Abate Task Runner: test-boundaries (Constitutional & Isolation Gates) ===
  ✔ Foreign tenant ID returns zero rows (Row-Level Security hides existence)
  ✔ Missing tenant context fails closed (0 rows accessible without tenant context)
  ✔ Pooled connection reuse does not leak tenant context across requests
  ✔ Command pipeline returns cached response on exact replay and CONFLICT on payload mutation
  ✔ Querying a foreign tenant's organization produces safe 404 NOT_FOUND
  ✔ Outbox publisher handles crashes and consumer inbox deduplicates duplicate deliveries
  ✔ Decoy Lab: Prohibited fields (screenshots, sick reason) are rejected with zero persistence trace
  ✔ Duplicate batch delivery returns previous receipt and adds zero work facts
  ✔ Higher revision appends new record without destroying historical revision 1
  ✔ Paused connector refuses ingestion immediately with 403 FORBIDDEN
  ✔ Connection lag > 3x cadence evaluates to STALE health (no data != zero work)
[SUCCESS] All 11 boundary, isolation, and reliability tests passed.
```

---

### Step 2: Running the Live Application

1. **Start the Backend Server (Port 5000):**
   ```bash
   cd backend
   npm start
   # Server runs at http://127.0.0.1:5000
   ```

2. **Start the Frontend Application (Port 5173):**
   ```bash
   cd frontend
   npm run dev
   # Vite development server runs at http://localhost:5173
   ```

3. Open your browser to `http://localhost:5173`. You will see the green **"Backend Connected"** indicator in the navbar.

---

### Step 3: Interactive UI Walkthrough

Click on the new tab in the navigation bar: **"Ingestion & Work Ledger (Phase 2)"**.

#### 1. Ingestion Testing Lab & Verification Scenarios
The UI features a dedicated **Interactive Ingestion Testing Lab** with 4 real-time scenario buttons:

- **Test A: Send Clean Batch**
  - Click **"Send Clean Batch"**.
  - **What happens:** A payload of 2 valid work interval records is parsed by the `ZoikoTimeBatchV1` contract.
  - **What to verify:**
    - A green alert appears: *"Standard Batch Ingested Successfully"*.
    - The **Traceable Ingestion Receipts** table gains a new receipt with `Accepted = 2`, `Duplicate = 0`, `Rejected = 0`.
    - The **Work-State Ledger** table gains 2 new records with `Revision = rev 1` and 64-character pseudonym hashes. Plaintext names or employee numbers are nowhere to be seen.

- **Test B: Duplicate Delivery Test (Idempotency)**
  - Click **"Send Duplicate Replay"**.
  - **What happens:** The exact same batch ID is transmitted again to simulate an upstream network retry.
  - **What to verify:**
    - A green alert confirms: *"Duplicate Batch Handled Idempotently"*.
    - The existing receipt is returned; `Accepted = 0`, `Duplicate = 1`.
    - No duplicate rows are created in the Work-State Ledger table.

- **Test C: Decoy Lab (Adversarial Surveillance Attack)**
  - Click **"Send Surveillance Decoy"**.
  - **What happens:** A rogue connector payload containing forbidden fields (`screenshotUrl`, `sickReason`, `windowTitle`) is transmitted.
  - **What to verify:**
    - A green confirmation appears: *"Physical Minimization Confirmed (Decoy Dropped)"*.
    - The API boundary caught the illegal fields and returned HTTP 400.
    - Zero bytes of surveillance data were stored in the database.

- **Test D: Revision 2 Correction (Append-Only Ledger)**
  - Click **"Send Revision 2"**.
  - **What happens:** A modified work interval with `revision: 2` is submitted for an existing record.
  - **What to verify:**
    - A green alert confirms: *"Revision 2 Appended to Ledger"*.
    - In the Work-State Ledger table, the original `rev 1` record is still present, and a new `rev 2` record is added alongside it.

#### 2. Source Connection Lifecycle & Freshness
- Inspect the **Source Connections & Cadence Health** card.
- In **Apex Legal Partners (Tenant A)**, the connection is active and within its 15-minute sync window, displaying a green **`Health: FRESH`** badge.
- Click **"Pause"** on the connection:
  - The connection state updates to `PAUSED`.
  - Attempting to submit any batch now immediately fails closed with HTTP 403 `FORBIDDEN`.
- Click **"Resume"** to restore ingestion capability.
- Switch the Active Tenant Scope in the top navbar to **Beacon Chambers (Tenant B)**:
  - Tenant B's seed connection has a watermark simulated from hours ago (> 3x cadence).
  - The badge immediately displays an orange **`Health: STALE`**, alerting the risk engine that the source is experiencing an outage.

---

### Step 4: Verification via Direct REST API (cURL)

You can also test the endpoints directly from PowerShell or Bash.

#### 1. Obtain a Tenant JWT Token
```bash
curl -X POST http://127.0.0.1:5000/api/v2/auth/token \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"00000000-0000-4000-a000-00000000000a","subject":"auth0|tester","role":"RISK_OWNER"}'
```
*Copy the `token` string from the JSON response.*

#### 2. Query Connections and Health
```bash
curl -X GET http://127.0.0.1:5000/api/v2/connections \
  -H "Authorization: Bearer <TOKEN>"
```

#### 3. Ingest a ZoikoTime Batch
```bash
curl -X POST http://127.0.0.1:5000/api/v2/connectors/zoikotime/batches \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "batchId": "manual-curl-01",
    "connectionId": "00000000-0000-4000-c000-000000000001",
    "sentAt": "2026-10-28T10:00:00.000Z",
    "records": [
      {
        "recordId": "rec-curl-01",
        "revision": 1,
        "recordedAt": "2026-10-28T10:00:00.000Z",
        "subjectId": "emp-curl-subject",
        "intervalStart": "2026-10-28T08:00:00.000Z",
        "intervalEnd": "2026-10-28T09:30:00.000Z",
        "workTz": "Europe/London",
        "kind": "ACTIVE_WORK"
      }
    ]
  }'
```

#### 4. Query the Work-State Ledger
```bash
curl -X GET http://127.0.0.1:5000/api/v2/work-facts \
  -H "Authorization: Bearer <TOKEN>"
```
*Notice that `pseudonym_id` is an irreversible HMAC-SHA256 hex string and `subjectId` is not returned.*

---

## 5. File & Directory Reference

| File | Purpose |
| :--- | :--- |
| [`backend/db/migrations/0020_ingest_ledger.sql`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/db/migrations/0020_ingest_ledger.sql) | DDL schema for `source_contract`, `connection`, `watermark`, `ingest_receipt`, `work_fact_revision` with PostgreSQL Row-Level Security. |
| [`backend/src/contracts/sources/zoikotime.v1.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/src/contracts/sources/zoikotime.v1.ts) | Strict Zod contracts (`ZoikoTimeIntervalV1.strict()`) enforcing unallowlisted field rejection and IANA timezone validation. |
| [`backend/src/domains/ingest/validate.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/src/domains/ingest/validate.ts) | Physical minimization partition logic that discards forbidden fields without logging payloads. |
| [`backend/src/domains/work/pseudonym.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/src/domains/work/pseudonym.ts) | Tenant-salted HMAC-SHA256 pseudonym derivation function. |
| [`backend/src/domains/ingest/freshness.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/src/domains/ingest/freshness.ts) | Cadence lag calculation and health derivation (`FRESH`, `DELAYED`, `STALE`, `NEVER_SYNCED`). |
| [`backend/src/domains/ingest/ingest-batch.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/src/domains/ingest/ingest-batch.ts) | Atomic ingestion transaction: connection validation, fact insertion, receipt persistence, and transactional outbox emission. |
| [`backend/src/domains/ingest/connections.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/src/domains/ingest/connections.ts) | Queries and state mutations for connections, receipts, and work-state facts. |
| [`backend/tools/test-boundaries.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/backend/tools/test-boundaries.ts) | 11 constitutional boundary tests covering decoy minimization, duplicate idempotency, append-only revisions, and cadence staleness. |
| [`frontend/src/components/Tabs/IngestionTab.tsx`](file:///c:/Users/aparaziitha%20nitta/Abate/frontend/src/components/Tabs/IngestionTab.tsx) | Live interactive operator UI tab with Testing Lab, Connection monitors, Receipts table, and Work-State Ledger table. |
| [`frontend/src/api/client.ts`](file:///c:/Users/aparaziitha%20nitta/Abate/frontend/src/api/client.ts) | Frontend API client with typed methods for connections, receipts, work facts, and ZoikoTime batch submission. |

