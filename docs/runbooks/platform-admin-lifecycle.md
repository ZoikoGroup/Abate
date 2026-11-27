# Runbook: Platform Admin Lifecycle & Break-Glass Operations

- **Status:** `DRAFT — PENDING SECURITY OWNER REVIEW`
- **Scope:** Bootstrapping the initial Super Admin pair, adding, changing, disabling, and reviewing Platform Staff accounts (`SUPER_ADMIN`, `OPS_SUPPORT`, and `break_glass`)
- **Related ADR:** `docs/architecture/ADR-007-admin-model-stepup-foureyes.md` (`DRAFT — PENDING SECURITY OWNER APPROVAL`)
- **Primary Endpoints:** `POST /api/v2/admin/session/oidc/exchange`, `POST /api/v2/admin/session/step-up`, `GET/POST /api/v2/admin/platform-users`, `PATCH /api/v2/admin/platform-users/:userId/role`, `POST /api/v2/admin/platform-users/:userId/disable`, `GET/POST /api/v2/admin/approvals/:id/(approve|reject)`

---

## 0. Day-0 Initial Pair Bootstrap (Avoiding Four-Eyes Bypass or Deadlock)

Four-eyes dual control requires **at least two distinct named `SUPER_ADMIN` accounts** before normal platform operation begins. Bootstrapping only one Super Admin deadlocks all four-eyes workflows; bypassing four-eyes at runtime weakens dual control. Use the following one-time out-of-band Day-0 procedure for every new staging or production environment:

1. **Identity Provider Provisioning (Out-of-Band):** Security Owner and Platform Engineering Lead designate **two distinct named staff members** (e.g., `alice.patel@zoikoabate.dev` and `bob.kumar@zoikoabate.dev`) in the corporate IdP's `platform-super-admin` group with **phishing-resistant MFA** (`amr` containing `hwk`/`webauthn`/`fido`/`mfa` and fresh `auth_time`) and audience `<AUTH_AUDIENCE>:support`.
2. **Initial Database Seed (Before Public Ingress Opens):** During environment provisioning (under change-control ticket), run a controlled one-time bootstrap SQL insert as `abate_platform_admin` (or via controlled provisioning job, never as `abate_app` or `abate_ops`) inserting both named `SUPER_ADMIN` rows into `platform_user` (`status = 'ACTIVE'`, `break_glass = false`, `mfa_enforced = true`) and logging the bootstrap ticket reference into `platform_audit_event`.
3. **Verify Dual-Control Readiness:** Both operators sign in via OIDC (`POST /api/v2/admin/session/oidc/exchange`), verify `GET /api/v2/admin/me` returns `authMethod: "oidc"` and `mfaVerified: true`, and verify `GET /api/v2/admin/platform-users` lists both active named `SUPER_ADMIN` accounts.
4. **Runtime Deadlock Guard (Enforced in Code):** Once operational, `PATCH /api/v2/admin/platform-users/:userId/role`, `POST /api/v2/admin/platform-users/:userId/disable`, and approval execution (`executeApprovedAction`) all enforce a **minimum-2 active named `SUPER_ADMIN` guard** (`409 CONFLICT`) so operators cannot accidentally demote or disable the roster below two approvers. To rotate out a founding Super Admin, add the replacement via four-eyes first (bringing active count to 3), then disable the departing account via four-eyes (leaving 2).

---

## 1. Account Naming & MFA Rules

1. **Named Individuals Only:** Every platform operator MUST have an individual identity (e.g., `alice.patel@zoikoabate.dev`). Shared or generic names (`admin@`, `superadmin@`, `root@`, `support@`, `ops@`, `system@`, `shared@`, `service@`, `bot@`) are rejected with `400 VALIDATION` unless explicitly provisioned as an audited `breakGlass: true` emergency account.
2. **Hardware/Phishing-Resistant MFA Required:** All `SUPER_ADMIN` accounts MUST enforce IdP MFA (`mfa_enforced = true`), short session TTL (`ADMIN_SESSION_TTL_SECONDS`, default `900s`), and recent step-up re-authentication (`ADMIN_STEP_UP_WINDOW_SECONDS`, default `300s`).
3. **Zero Dual Hatting:** Platform staff subjects registered in `platform_user` are refused (`403 FORBIDDEN`) from holding memberships inside customer tenants (`POST /api/v2/admin/tenants/:tenantId/memberships`).

---

## 2. Adding a Platform Operator

### A. Adding `OPS_SUPPORT` (Read-Only Operational Views)
1. Confirm manager & security approval ticket reference.
2. Verify Step-Up (`POST /api/v2/admin/session/step-up` or **Verify Step-Up** button in Super Admin Console).
3. Submit `POST /api/v2/admin/platform-users` with `subject`, `displayName`, `platformRole: "OPS_SUPPORT"`, `breakGlass: false`, and ticket reference in `reason`.
4. Confirm `platform_audit_event` records `platform_user.create` with `operator`, `reason`, `request_id`, and `step_up_verified = true`.

### B. Adding or Promoting a `SUPER_ADMIN` (Four-Eyes Mandatory)
1. **Initiator (Admin #1):** Verify Step-Up and submit `POST /api/v2/admin/platform-users` (`platformRole: "SUPER_ADMIN"`) or `PATCH /api/v2/admin/platform-users/:userId/role` (`platformRole: "SUPER_ADMIN"`). The backend returns `202 PENDING_APPROVAL` and queues an `admin_approval_request` (24-hour expiry).
2. **Second Distinct Approver (Admin #2):** Verify Step-Up under a distinct Super Admin identity, review the ticket and request details in **Four-Eyes Approvals**, and submit `POST /api/v2/admin/approvals/:id/approve` with verification reason.
   - Self-approval by Admin #1 is refused (`403 FORBIDDEN`) in both API logic and DB constraint `chk_four_eyes_distinct_approver`.
   - Replaying an executed/rejected/expired approval is refused (`409 CONFLICT`).
3. Confirm the new operator appears as `ACTIVE` in `GET /api/v2/admin/platform-users` and `platform_audit_event` captures both `operator` and `approver`.

---

## 3. Removing / Disabling a Platform Operator

1. **Immediate Offboarding Trigger:** When a staff member leaves or changes role, disable their IdP account immediately and disable their Abate `platform_user` row:
   - **Self-disable is refused (`409 CONFLICT`)** to prevent accidental lockout.
   - **Four-Eyes Deadlock Guard (`409 CONFLICT`):** Disabling or demoting a named `SUPER_ADMIN` is refused if only 2 active named non-break-glass `SUPER_ADMIN` accounts exist. Add and approve a replacement `SUPER_ADMIN` first (Section 2B) before disabling the departing one.
   - Disabling `OPS_SUPPORT`: requires Step-Up (`200 OK`).
   - Disabling `SUPER_ADMIN`: requires Step-Up + Four-Eyes approval by a second distinct `SUPER_ADMIN` (`202` -> `200`).
2. Never delete historical `platform_user` rows or `platform_audit_event` records; `DISABLED` preserves immutable historical attribution.
3. Verify any active admin cookies expire within `ADMIN_SESSION_TTL_SECONDS` (default 15 minutes) and IdP sessions are revoked.

---

## 4. Break-Glass Emergency Account Procedure

1. **Provisioning:** Break-glass accounts (`breakGlass: true`) require Four-Eyes approval to create, are stored offline in a split-custody vault, and are NEVER used for routine administration.
2. **Activation & Alerting:**
   - Any authentication or mutation by a break-glass account MUST trigger a high-priority security alert to the Security Owner and engineering lead.
   - Record incident ticket number in every mandatory `reason` field.
3. **Post-Incident Teardown (within 24 hours):**
   - Rotate break-glass IdP credentials and MFA seeds.
   - Export the relevant window via `POST /api/v2/admin/audit/export` (audited export) and attach to the post-incident review.
   - Conduct mandatory Security Owner review of every action taken during the break-glass window.

---

## 5. Quarterly Access Review

1. Run `GET /api/v2/admin/platform-users` and `POST /api/v2/admin/audit/export` (`format: "csv"`, reason `"Quarterly platform admin access review"`).
2. Verify every `ACTIVE` `SUPER_ADMIN` and `OPS_SUPPORT` account maps to a current named individual with hardware/IdP MFA enabled.
3. Disable any unused or role-changed accounts following Section 3 above.
