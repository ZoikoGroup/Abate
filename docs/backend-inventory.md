# Zoiko Abate Backend Inventory (Phases 0 & 1)

This inventory document provides an authoritative, code-verified audit of the running Abate backend service (`http://localhost:5000` / `/api/v2`), its exact routes, request/response contracts, transactional side effects, authentication mechanics, and seeded fixtures.

## Database Migration Workflow

Run migrations from `backend/` with `npm run migrate` after PostgreSQL is available and the migrator connection is configured. The runner serializes concurrent executions with a PostgreSQL advisory lock, records each applied SQL file and SHA-256 checksum in `schema_migrations`, and applies each new migration in its own transaction. A connection or migration error exits non-zero; it is not treated as an in-memory migration.

---

## 1. Routes & Contract Catalog

### Step 1: Health & System Metadata
* **Route**: `GET /api/health`
  * **Auth Required**: None (Public)
  * **Headers**: None
  * **Request Body**: None
  * **Success Status**: `200 OK`
  * **Success Response Shape**:
    ```json
    {
      "status": "ok",
      "app": "Zoiko Abate",
      "version": "1.0.0",
      "environment": "local",
      "timestamp": "2026-11-06T13:20:00.000Z",
      "constitutionalBoundaries": {
        "individualScoring": "PROHIBITED",
        "surveillanceMining": "PROHIBITED",
        "clinicalDependency": "PROHIBITED",
        "privacyGate": "CLASS_B_C_MIN_10_CONTRIBUTORS",
        "planeSeparation": "PLANE_B_CANNOT_MUTATE_PLANE_A",
        "supportModel": "ZERO_IMPERSONATION_SIGNED_DIAGNOSTICS"
      }
    }
    ```
  * **Error Response**: None expected on normal operation.

* **Route**: `GET /api/info`
  * **Auth Required**: None (Public)
  * **Headers**: None
  * **Request Body**: None
  * **Success Status**: `200 OK`
  * **Success Response Shape**:
    ```json
    {
      "app": "Zoiko Abate",
      "version": "1.0.0",
      "description": "Organizational work-design and psychosocial-risk infrastructure.",
      "architecture": {
        "framework": "TypeScript / Node.js Modular Monolith",
        "databaseRoles": "Separate abate_migrator and restricted abate_app (NOSUPERUSER, NOBYPASSRLS)",
        "isolation": "PostgreSQL Forced Row-Level Security with transaction-local context",
        "reliability": "Single command pipeline with Idempotency, Append-Only Audit, and Outbox"
      },
      "domains": {
        "S01": "Tenant, access, organization (Active)",
        "S02_S03": "Ingestion / work-state ledger",
        "S04_S06": "Measurement / Privacy Release",
        "S05_S07": "Hazards / interventions",
        "S08_S09": "Bounded AI / action execution",
        "S10": "Governance and evidence",
        "S11_S12": "Commercial / lifecycle (jurisdiction packs, retention, legal hold)"
      }
    }
    ```

---

### Step 2: Canonical OpenAPI Specification
* **Route**: `GET /api/v2/contracts/openapi.json`
  * **Auth Required**: None (Public)
  * **Headers**: None
  * **Request Body**: None
  * **Success Status**: `200 OK`
  * **Success Response Shape**: OpenAPI 3.1.0 document:
    ```json
    {
      "openapi": "3.1.0",
      "info": {
        "title": "Zoiko Abate Authoritative API Contract Registry",
        "version": "2.0.0",
        "description": "Production API specification for Zoiko Abate..."
      },
      "servers": [{ "url": "/api/v2", "description": "API v2 Base (Default Tenant Environment)" }],
      "paths": { ... }
    }
    ```

---

### Step 3: Identity & Authentication
* **Route**: `POST /api/v2/auth/token`
  * **Auth Required**: None (Development/Demo Token Issuer)
  * **Headers**: `Content-Type: application/json`
  * **Request Body Shape**:
    ```json
    {
      "tenantId": "00000000-0000-4000-a000-00000000000a",
      "subject": "auth0|user-tenant-a-risk-owner",
      "role": "RISK_OWNER",
      "purpose": "WORKPLACE_RISK_ASSESSMENT"
    }
    ```
  * **Success Status**: `200 OK`
  * **Success Response Shape**:
    ```json
    {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "tokenType": "Bearer",
      "expiresIn": "8h",
      "tenantId": "00000000-0000-4000-a000-00000000000a",
      "subject": "auth0|user-tenant-a-risk-owner",
      "role": "RISK_OWNER"
    }
    ```
  * **Error Response** (`400 Bad Request`):
    ```json
    {
      "code": "VALIDATION",
      "message": "Validation failed: tenantId: Required",
      "requestId": "2b9ce348-7359-42b7-a37a-4a6435cceef6"
    }
    ```

---

### Step 4, 5, 6, 7: Idempotent Command Execution (Organizations)
* **Route**: `POST /api/v2/organizations`
  * **Auth Required**: Yes (`Authorization: Bearer <token>`)
  * **Required Headers**:
    * `Idempotency-Key`: UUID string (e.g. `9f8b2c41-7a2e-4f10-b98a-123456789abc`)
  * **Request Body Shape**:
    ```json
    {
      "name": "Corporate Litigation Practice",
      "parentId": "00000000-0000-4000-a001-000000000001"
    }
    ```
    *(Note: `parentId` is optional)*
  * **Success Status**: `200 OK`
  * **Success Response Shape**:
    ```json
    {
      "id": "e93bfd23-7729-4a49-a359-541571f5446a",
      "tenantId": "00000000-0000-4000-a000-00000000000a",
      "parentId": null,
      "name": "Corporate Litigation Practice",
      "createdAt": "2026-11-06T13:20:00.000Z"
    }
    ```
  * **Idempotency Replay (Step 5)**:
    * Re-sending with the identical `Idempotency-Key` and identical payload body returns the cached response with `200 OK`. No second row is inserted in `organization`.
  * **Payload Hash Conflict (Step 6)**:
    * Re-sending with the SAME `Idempotency-Key` but modified `name` returns:
    * **Status**: `409 Conflict`
    * **Response Body**:
      ```json
      {
        "code": "CONFLICT",
        "message": "Idempotency key reused with different payload",
        "requestId": "8f03be9a-f432-4e08-9ef6-c73ab901d821"
      }
      ```
  * **Missing Idempotency-Key Header (Step 7)**:
    * Omitting `Idempotency-Key` header returns:
    * **Status**: `400 Bad Request`
    * **Response Body**:
      ```json
      {
        "code": "VALIDATION",
        "message": "Header 'Idempotency-Key' is required for all state-changing commands.",
        "requestId": "5a41bf39-4d62-43ce-b789-80517fa918ec"
      }
      ```

---

### Step 8: Multi-Tenant Database Isolation
* **Route**: `GET /api/v2/organizations`
  * **Auth Required**: Yes (`Authorization: Bearer <token>`)
  * **Success Status**: `200 OK`
  * **Success Response Shape**:
    ```json
    [
      {
        "id": "00000000-0000-4000-a001-000000000001",
        "tenant_id": "00000000-0000-4000-a000-00000000000a",
        "parent_id": null,
        "name": "Corporate Litigation Practice"
      }
    ]
    ```
  * **Isolation Guarantee**: When called with Tenant B token, PostgreSQL RLS (`tenant_id = current_setting('app.tenant_id')`) prevents any Tenant A rows from leaking into Tenant B's results.

* **Route**: `GET /api/v2/tenants/current`
  * **Auth Required**: Yes (`Authorization: Bearer <token>`)
  * **Success Status**: `200 OK`
  * **Success Response Shape**:
    ```json
    {
      "id": "00000000-0000-4000-a000-00000000000a",
      "name": "Apex Legal Partners (Tenant A)",
      "region": "eu-west-2",
      "createdAt": "2025-12-02T09:00:00.000Z"
    }
    ```

---

## 2. Authentication Architecture

1. **Token Generation**:
   `POST /api/v2/auth/token` mints an HMAC-SHA256 signed JWT using `process.env.AUTH_SECRET`.
2. **Token Claims**:
   * `sub`: External user subject (e.g. `auth0|user-tenant-a-risk-owner`)
   * `tenantId`: Active tenant UUID (e.g. `00000000-0000-4000-a000-00000000000a`)
   * `role`: User's domain role (`RISK_OWNER`, `CONTROL_OWNER`, `REVIEWER`, `EMPLOYER_ADMIN`)
   * `purpose`: Context purpose (`WORKPLACE_RISK_ASSESSMENT`)
   * `iss`: Issuer (`http://localhost:5000/auth`)
   * `aud`: Audience (`abate-api`)
   * `exp`: Expiry timestamp (8 hours from generation)
3. **Identity Derivation Principle**:
   Tenant context is **never** accepted from the HTTP request body. It is derived exclusively from the authenticated JWT claims.

---

## 3. Atomic Transactional Writes (The 4-Way Invariant)

Every state-changing domain command executes through `runCommand` (`backend/src/platform/command.ts`) inside a single atomic transaction writing to 4 SQL tables:

1. **`idempotency_record`**:
   Claims the `(tenant_id, operation, idempotency_key)` tuple. Records the SHA-256 payload hash and caches the finalized response status and body.
2. **`organization`**:
   Inserts the business entity scoped by `tenant_id`.
3. **`audit_event`**:
   Writes an immutable audit log entry containing `tenant_id`, `actor_id`, `purpose`, `command`, `resource_type`, `resource_id`, and `result: 'SUCCESS'`.
4. **`outbox_event`**:
   Writes the domain event (`organization.created`) with aggregate ID and purpose, ready for worker drain.

If any of these 4 writes fails, the entire transaction rolls back cleanly.

---

## 4. Seeded Demo Data (ABATE-GOLDEN-01)

* **Fixed Test Clock**: `2026-03-02T09:00:00Z`
* **Tenant A**:
  * `id`: `00000000-0000-4000-a000-00000000000a`
  * `name`: `Apex Legal Partners (Tenant A)`
  * `subject`: `auth0|user-tenant-a-risk-owner`
  * `role`: `RISK_OWNER`
  * `organization_id`: `00000000-0000-4000-a001-000000000001`
  * `organization_name`: `Corporate Litigation Practice`
* **Tenant B**:
  * `id`: `00000000-0000-4000-b000-00000000000b`
  * `name`: `Beacon Chambers (Tenant B)`
  * `subject`: `auth0|user-tenant-b-risk-owner`
  * `role`: `RISK_OWNER`
  * `organization_id`: `00000000-0000-4000-b001-000000000001`
  * `organization_name`: `Commercial Arbitration Chambers`

---

## 5. Compliance Audit vs Phase 0 & Phase 1 Specifications

| Requirement | Implementation Status | Notes |
| :--- | :--- | :--- |
| Zero Individual Scoring | Verified | Never evaluates individual productivity; no employee ranking. |
| Strict Row-Level Security | Verified | Enforced via PostgreSQL policies and transaction settings. |
| Idempotency Pipeline | Verified | Replay returns cached response; conflict returns 409. |
| Append-Only Audit Trail | Verified | Written atomically with business changes. |
| Transactional Outbox | Verified | Asynchronously published; worker crash safe. |
| Single Read Path | Verified | Public views read aggregated artifacts only. |

---

## 6. CORS & Transport Configuration

* **CORS**: Enabled in `backend/src/index.ts` with `origin: cfg.clientUrl` (`http://localhost:5173`) and `credentials: true`.
* **Vite Proxy**: `frontend/vite.config.ts` proxies all `/api/*` calls directly to `http://127.0.0.1:5000`.

---

## 7. Test Reporting (JSON Artifact)

The test runner `backend/tools/test-boundaries.ts` runs 57 boundary, isolation, and reliability tests. It writes a machine-readable JSON artifact:
* **Path**: `frontend/public/test-report.json`
* **Contents**:
  * `suite`: `"Abate Boundary Invariants & Isolation Suite"`
  * `command`: `"npm run test-boundaries"`
  * `total`: 57
  * `passed`: 57
  * `failed`: 0
  * `tests`: Array of `{ name: string, status: "PASS" | "FAIL", durationMs: number }`

---

## 8. Demo Steps Verification Matrix

| Step | Button | Real Endpoint Call | What It Proves | Verified Working |
| :---: | :--- | :--- | :--- | :---: |
| **1** | Check Backend | `GET /api/health`, `GET /api/info` | Backend is live, unmocked, lists domains | **YES** |
| **2** | Show Contract | `GET /api/v2/contracts/openapi.json` | OpenAPI 3.1 single source of truth | **YES** |
| **3** | Sign in as Tenant A | `POST /api/v2/auth/token` | Identity derives tenant from token | **YES** |
| **4** | Create Organization | `POST /api/v2/organizations` | Idempotency + Audit + Outbox written atomically | **YES** |
| **5** | Resend Same Request | `POST /api/v2/organizations` (same key) | Replay deduplication; no duplicate rows | **YES** |
| **6** | Change Body, Same Key | `POST /api/v2/organizations` (changed name) | 409 CONFLICT payload tampering prevention | **YES** |
| **7** | Skip Idempotency Key | `POST /api/v2/organizations` (no header) | 400 VALIDATION fail-closed requirement | **YES** |
| **8** | Switch to Tenant B | `POST /api/v2/auth/token` + `GET /api/v2/organizations` | Database RLS isolation: B sees 0 rows of A | **YES** |
| **9** | Test Evidence | Reads `frontend/public/test-report.json` | 57 automated boundary tests pass | **YES** |
| **10** | Roadmap | None (Static Blueprint) | Phases 2-8 clearly demarcated | **YES** |
