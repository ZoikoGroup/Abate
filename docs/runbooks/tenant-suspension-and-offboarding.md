# Runbook: Tenant Suspension, Reactivation & Governed Offboarding

- **Status:** `DRAFT — PENDING SECURITY OWNER REVIEW`
- **Scope:** Suspending customer workspaces, reactivating them cleanly, and offboarding tenants via retention, legal holds, and cryptographic tombstones (**never hard delete**)
- **Related ADR:** `docs/architecture/ADR-007-admin-model-stepup-foureyes.md` (`DRAFT — PENDING SECURITY OWNER APPROVAL`)
- **Primary Endpoints:** `GET/PATCH /api/v2/admin/tenants/:tenantId`, `POST /api/v2/admin/tenants/:tenantId/state`, `POST /api/v2/admin/tenants/:tenantId/offboard-request`, `POST /api/v2/admin/approvals/:id/approve`

---

## 1. Constitutional & Data-Integrity Invariants

1. **No Instant Hard Delete:** Platform Super Admins have **no** `DELETE /api/v2/admin/tenants/:tenantId` endpoint and `abate_platform_admin` has zero `DELETE` privileges on `tenant` or any tenant business table.
2. **Zero Business-Data Exposure:** Suspension and offboarding operate strictly on tenant metadata (`state`, `offboard_requested_at`, `offboard_reason`, `version`) using `abate_platform_admin`. Platform staff never inspect tenant work facts, hazards, controls, or privacy releases.
3. **Optimistic Concurrency (`ETag` / `If-Match`):** Fetch the latest tenant version via `GET /api/v2/admin/tenants/:tenantId` and send `If-Match: "<version>"` on updates or state transitions. On `409 CONFLICT`, reload the tenant record before retrying.

---

## 2. Suspending a Tenant (Step-Up + Four-Eyes Mandatory)

Use suspension for security containment, contractual hold, or emergency maintenance. Suspending immediately stops customer API requests (`403 FORBIDDEN` in `resolveActor`) and connector ingestion while preserving all stored data intact.

1. **Admin #1 (Initiator):**
   - Complete Step-Up Re-Authentication (`POST /api/v2/admin/session/step-up` or **Verify Step-Up** in Super Admin Console).
   - Submit `POST /api/v2/admin/tenants/:tenantId/state` with `If-Match: "<version>"` and body:
     ```json
     { "state": "SUSPENDED", "reason": "Ticket #INC-1234: customer-requested security pause" }
     ```
   - Backend returns **`202 Accepted`** (`status: "PENDING_APPROVAL"`) with `approvalRequest.id`.
2. **Admin #2 (Second Distinct Super Admin):**
   - Verify the customer/security ticket independently.
   - Complete Step-Up Re-Authentication under Admin #2's own named account.
   - Approve via `POST /api/v2/admin/approvals/:id/approve` (or **Four-Eyes Approvals -> Approve**) with a clear decision `reason`.
   - Backend sets `tenant.state = 'SUSPENDED'`, increments `tenant.version`, marks the approval `EXECUTED`, and writes an immutable `platform_audit_event` (`action: "tenant.suspend"`, recording both `operator` and `approver`).
3. **Verification:**
   - Confirm `GET /api/v2/admin/tenants/:tenantId` shows `state: "SUSPENDED"`.
   - Confirm `GET /api/v2/admin/audit?action=tenant.suspend` records `operator`, `approver`, `reason`, `request_id`, and `step_up_verified: true`.

---

## 3. Reactivating a Suspended Tenant

1. Confirm containment or billing/contractual hold is resolved and documented in the support/security ticket.
2. Complete Step-Up Re-Authentication (`POST /api/v2/admin/session/step-up`).
3. Submit `POST /api/v2/admin/tenants/:tenantId/state` with current `If-Match: "<version>"` and body:
   ```json
   { "state": "ACTIVE", "reason": "Ticket #INC-1234 resolved; customer authorized reactivation" }
   ```
4. Backend returns `200 OK` (`state: "ACTIVE"`), increments `version`, and logs `tenant.activate` to `platform_audit_event`.
5. Ask the customer Tenant Admin (`EMPLOYER_ADMIN`) to verify login and resume any suspended connectors via **Tenant Admin -> Connections**.

---

## 4. Governed Tenant Offboarding (Retention + Legal Hold + Tombstone)

Offboarding follows the Phase 5 retention, legal-hold, and tombstone lifecycle so statutory holds and auditability are never violated:

1. **Customer Notice & Export Window:**
   - Before offboarding, the customer Tenant Admin (`EMPLOYER_ADMIN`) exports any required cryptographic evidence packages (`POST /api/v2/evidence-packages`) and resolves or confirms active legal holds (`GET /api/v2/retention`).
   - Pause or permanently disconnect active connectors (`POST /api/v2/connections/:id/disconnect`) to halt new telemetry.
2. **Suspend Workspace (if not already suspended):** Follow Section 2 above so no new sessions or writes occur.
3. **Queue Four-Eyes Offboard Request:**
   - **Admin #1** (with active Step-Up) calls `POST /api/v2/admin/tenants/:tenantId/offboard-request` with `If-Match: "<version>"` and a detailed `reason` (min 10 characters, including contract termination / DPA ticket ID). Returns `202 PENDING_APPROVAL`.
   - **Admin #2** (distinct Super Admin with active Step-Up) reviews and approves via `POST /api/v2/admin/approvals/:id/approve`.
   - Backend stamps `offboard_requested_at` and `offboard_reason` on `tenant` and records `tenant.offboard.request` with `workflow: "RETENTION_LEGAL_HOLD_TOMBSTONE"`.
4. **Retention & Tombstone Execution:**
   - Existing Phase 5 scheduled retention (`POST /api/v2/retention/runs` / worker retention executor) honors all active `legal_hold` rows, purges only unheld records past their approved retention period, and writes cryptographic `deletion_tombstone` records (plus external object-store tombstone artifacts so backup restores can never resurrect purged rows).
   - `audit_event`, `platform_audit_event`, and `deletion_tombstone` remain immutable for statutory evidence.
