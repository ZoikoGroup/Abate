# ADR-007: Four-Tier Admin Model, Dedicated Platform Admin Role, Step-Up Re-Authentication & Four-Eyes Governance

- **Status:** `DRAFT — PENDING SECURITY OWNER APPROVAL`
- **Date:** 2026-11-27
- **Context:** Migration `0094_platform_admin_role_and_governance.sql`, `backend/db/init/01-roles.sql`, `backend/src/routes/admin.ts`, `backend/src/routes/tenant-admin.ts`, `backend/src/domains/support/support-auth.ts`, `backend/src/domains/tenant/auth.ts`

---

## 1. Context & Problem Statement

Before this ADR, `/api/v2/admin/*` routes shared the `abate_ops` database role (`0092_super_admin_platform_ops.sql`), did not separate platform administration from operational read-only support at the PostgreSQL role layer, lacked step-up re-authentication and four-eyes dual control on destructive platform actions, exposed raw tenant `external_subject` identifiers in the Super Admin UI, and allowed `EMPLOYER_ADMIN` to hold implicit control-approval privileges via `APPROVAL_ROLES`.

A complete governance boundary requires explicit separation across **four runtime tiers plus the offline Release Authority**, enforced in PostgreSQL privileges, RLS policies, JWT/cookie audiences, server-side authorization middleware, and separate UI shells.

---

## 2. Four-Tier + Release Authority Permission Matrix

| Tier | Identity / Credentials | Database Role | Permitted Operations | Strictly Prohibited (Enforced in Code & DB) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Platform Super Admin** | Named platform staff (`SUPER_ADMIN`, audience `abate:support`, scope `platform-super-admin`, MFA + short TTL + step-up) | `abate_platform_admin` (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) | Create/edit tenants, suspend/reactivate tenants (suspend via four-eyes), queue retention/hold/tombstone offboarding (four-eyes), assign launched/baseline sector packs (launched via four-eyes), manage feature flags (enable via four-eyes), set commercial entitlements, configure per-tenant AI monthly quota caps, request AI/tool kill switches (four-eyes), manage named platform staff accounts (four-eyes for `SUPER_ADMIN`/break-glass), bootstrap initial tenant `EMPLOYER_ADMIN` only, view pseudonymous/masked tenant access metadata (every view audited), search and audited-export `platform_audit_event`, read operational health & read-only release dossier | Read or write ANY tenant business or protected table (`work_fact`, `ingest_receipt`, `metric_snapshot`, `disclosure_ledger`, `identity_map`, `privacy_release`, `hazard`, `cause`, `intervention`, `approval`, `ai_run`, `audit_event`, `tenant_invitation`, etc.); impersonate tenant users; call any `/api/v2/*` tenant route (`401`); grant workflow approval roles (`APPROVER`, `RISK_OWNER`, `CONTROL_OWNER`, `REVIEWER`); enable `PREVIEW`/`FIXTURE` sector packs (`403`); ratify the release dossier |
| **2. Platform Ops / Support** | Named operations staff (`OPS_SUPPORT`, audience `abate:support`, scope `platform-support`) | `abate_ops` (de-escalated in `0094`: all `0092` admin writes revoked) | Read content-free operational views (`ops_active_tenants`, `ops_connector_health`, SLO reports, safe error fingerprints, async/outbox job status, per-tenant AI quota config), verify HMAC-signed diagnostic receipts, replay dead-letter outbox entries with mandatory reason, toggle operational kill switches with mandatory reason | Call any `/api/v2/admin/*` route (`403`); call any tenant or `/api/v2/tenant-admin/*` route (`401`); read tenant business rows or sensitive columns (`tenant.name`, `connection.contract_id`); mutate tenant metadata or memberships |
| **3. Tenant Admin** | Customer administrator (`EMPLOYER_ADMIN`, tenant OIDC/JWT audience, strictly scoped to one `tenant_id`) | `abate_app` (`FORCE ROW LEVEL SECURITY` pinned to `app.tenant_id`) | Manage own-tenant users (list, inspect, deactivate, reactivate), assign and end effective-dated domain role memberships (rechecking approver authority at effective date), create/list/revoke OIDC invitations (masked email + HMAC hash stored), create/edit/reparent own organizations, manage own connections (register, pause, suspend, resume, permanently disconnect with confirmation), switch between launched/baseline sector packs, manage retention classes, legal holds & rights requests, search own tenant audit trail, view unified tenant usage/quotas | View or touch any other tenant (foreign ID and nonexistent ID return identical `404 NOT_FOUND`); alter the constitutional privacy floor (`n >= 10`, `28d`, `5/5`); enable `PREVIEW`/`FIXTURE` sector packs (`403`); approve controls (`POST /api/v2/controls/:id/approve` -> `403`) or set hazard dispositions (`POST /api/v2/hazards/:id/disposition` -> `403`) from `EMPLOYER_ADMIN` alone without also holding an explicit `APPROVER` or `RISK_OWNER` role |
| **4. Tenant Domain Roles** | Customer domain staff (`RISK_OWNER`, `CONTROL_OWNER`, `APPROVER`, `REVIEWER`, `IMPLEMENTATION_OWNER`, `DPO`, `PRIVACY_OFFICER`, `VIEWER`, `WORKER_REP`) | `abate_app` (`FORCE ROW LEVEL SECURITY`) | Execute domain workflows permitted in `PERMISSION_REGISTRY` (`backend/src/domains/tenant/auth.ts`); only `APPROVER` and `RISK_OWNER` hold `control.approve` and `hazard.disposition` authority | Manage tenant users, memberships, or OIDC invitations (`403` for non-`EMPLOYER_ADMIN`); access platform admin or ops routes (`401`) |
| **5. Release Authority (Offline)** | Named human Release Authority outside the runtime web app | Offline CLI only (`sign-dossier.ts`) | Run offline cryptographic release dossier signing (`RATIFIED`) after human governance gates close | Never reachable from any HTTP endpoint, Super Admin button, or Tenant Admin UI |

---

## 3. Architectural Decisions

### 3.1 Dedicated PostgreSQL Role `abate_platform_admin` (`0094`)
- Created in `backend/db/init/01-roles.sql` and `backend/db/migrations/0094_platform_admin_role_and_governance.sql` with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`.
- Mounted through a dedicated connection pool `withPlatformAdmin()` using `DATABASE_URL_PLATFORM_ADMIN` (verified distinct from `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_OPS`, and `DATABASE_URL_WORKER` in hardened environments).
- Holds column-limited grants and cross-tenant metadata RLS ONLY on platform/tenant metadata tables (`tenant`, `organization` root provisioning only, `principal` metadata, `effective_membership`, `tenant_sector_setting`, `feature_flag`, `ai_kill_switch`, `platform_audit_event` `SELECT`/`INSERT` append-only, `platform_user`, `admin_approval_request`, `tenant_ai_quota_config`, `tenant_entitlement`, and `ops_connector_health` read-only).
- Holds **ZERO** privileges on all 29 tenant business, measurement, privacy, hazard, control, AI-run, audit, and `tenant_invitation` tables.
- Migration `0094` revokes all broad `0092` admin write grants and policies from `abate_ops`, returning `abate_ops` to strict operational read/support scope.
- Both `db:audit` (live PG catalog queries #10–#14 + static audit) and `test-pg-parity` assert these exact boundaries in CI.

### 3.2 Admin Session Hardening, Cookie Separation, OIDC & Network Controls
- **Short Session TTL:** `ADMIN_SESSION_TTL_SECONDS` defaults to `900` seconds (15 minutes) and is bounded to `[60, 3600]`.
- **Dedicated Admin Cookies:** Separate from tenant sessions — `abate_admin_session` (`HttpOnly; SameSite=Strict; Path=/api/v2`, plus `Secure` in hardened environments) and companion `abate_admin_csrf` (`SameSite=Strict; Path=/api/v2`).
- **CSRF Check:** Every cookie-authenticated non-safe mutation (`POST`, `PUT`, `PATCH`, `DELETE`) on `/api/v2/admin/*` requires a matching `X-Admin-Csrf` header compared in constant time; missing or mismatched tokens fail closed with `403 FORBIDDEN`.
- **Staging/Production Dev-Token Lockdown:** Outside `local`/`test` (or whenever `ABATE_DISABLE_DEV_TOKEN=1`), `POST /api/v2/auth/super-admin-token` returns **`404 NOT_FOUND`** and HS256 dev tokens are refused. Platform Super Admins authenticate exclusively via asymmetric IdP OIDC JWTs (`RS256`/`ES256`) exchanged at `POST /api/v2/admin/session/oidc/exchange` into a signed `admin_oidc_session` cookie.
- **IP Allow-List (`ADMIN_IP_ALLOWLIST`) — Staging/Pilot Decision Gate:** `ADMIN_IP_ALLOWLIST` (comma-separated IPs) rejects admin requests outside the allow-list with `403 FORBIDDEN` (`assertAdminIpAllowed` in `support-auth.ts`). Currently **optional** in `validateRuntimeConfig()` (`backend/src/platform/config.ts`) so local/CI tests can run from ephemeral IPs; **Security Owner decision required** on whether staging and pilot deployments MUST set a non-empty VPN/bastion `ADMIN_IP_ALLOWLIST` (recommended: **REQUIRED** for staging and pilot admin ingress).

### 3.3 Step-Up Re-Authentication (`ADMIN_STEP_UP_WINDOW_SECONDS`)
- **Configuration:** `ADMIN_STEP_UP_WINDOW_SECONDS` defaults to `300` seconds (5 minutes, bounded `[30, 1800]`).
- **Real OIDC Claims Checked (`backend/src/domains/support/support-auth.ts`):**
  - In OIDC mode, `validateSupportClaims()` strictly checks IdP **`amr`** (`mfa`, `hwk`, `otp`, `webauthn`, `fido`) or **`acr`** (`mfa`, `aal2`, `aal3`) and rejects any `SUPER_ADMIN` OIDC token lacking MFA with **`401 UNAUTHORIZED`**.
  - Step-up recency strictly reads the IdP-signed **`auth_time`** claim (ignoring arbitrary `step_up_at` claims on external OIDC JWTs) and enforces `0 <= now - auth_time <= ADMIN_STEP_UP_WINDOW_SECONDS` in `assertStepUpRecent()`.
- **Endpoint (`POST /api/v2/admin/session/step-up`):**
  - **Hardened staging/production (`!isDevTokenEnabled` or OIDC session):** Never mints HS256 dev tokens. Requires a freshly re-authenticated IdP OIDC JWT (via `Authorization: Bearer` or `body.idToken` matching the active operator) with verified MFA and recent IdP `auth_time`, rotates the `admin_oidc_session` cookie, and records `admin.session.step_up` in `platform_audit_event`.
  - **Local/test dev mode only:** Stamps fresh `step_up_at` for local verification and Playwright E2E flows.
- **Enforcement:** Missing or expired step-up on destructive admin endpoints fails closed with **`401 UNAUTHORIZED`**.

### 3.4 Four-Eyes Approval Workflow (`admin_approval_request`) & Deadlock Prevention
- Backed by table `admin_approval_request` with PostgreSQL `CHECK` constraint `chk_four_eyes_distinct_approver` (`approved_by IS NULL OR lower(approved_by) <> lower(requested_by)`).
- Requesting any four-eyes action writes a `PENDING` request (24-hour expiry) and returns **`202 Accepted`** (`status: "PENDING_APPROVAL"`).
- **Day-0 Bootstrap & Deadlock Guard:** Every new staging/production environment provisions **two initial named `SUPER_ADMIN` accounts** out-of-band (documented in `docs/runbooks/platform-admin-lifecycle.md`). At runtime, demoting or disabling a named `SUPER_ADMIN` is refused (`409 CONFLICT`) if it would reduce active named non-break-glass `SUPER_ADMIN`s below 2.
- **Refusal Rules:**
  - Requester attempting to approve or reject own request -> **`403 FORBIDDEN`**.
  - Second distinct Super Admin approving/rejecting without recent step-up -> **`401 UNAUTHORIZED`**.
  - Replaying an already `EXECUTED`, `REJECTED`, or `EXPIRED` request -> **`409 CONFLICT`**.
- **Mandatory Four-Eyes Action List:**
  1. `tenant.suspend` (`POST /api/v2/admin/tenants/:tenantId/state` with `state: "SUSPENDED"`)
  2. `tenant.offboard.request` (`POST /api/v2/admin/tenants/:tenantId/offboard-request` — routes through retention/legal-hold/tombstone, never hard deletes)
  3. `sector_pack.enable` (`PUT /api/v2/admin/tenants/:tenantId/sector-pack` for `LAUNCHED` packs; `PREVIEW`/`FIXTURE` packs are always refused `403`)
  4. `feature_flag.enable` (`POST /api/v2/admin/feature-flags` with `enabled: true`)
  5. `ai.kill_switch.set` (`POST /api/v2/admin/kill-switches`)
  6. `platform_user.create` when `platformRole === "SUPER_ADMIN"` or `breakGlass === true`
  7. `platform_user.role.change` when promoting to `SUPER_ADMIN`
  8. `platform_user.disable` when disabling a `SUPER_ADMIN`

### 3.5 Privacy, Separation of Duties, Auditability & Preview-Pack Lockdown
- **DPO-Safe Principal Views (Zero Unmasked Admin Path):** `GET /api/v2/admin/tenants/:tenantId/principals` and `POST /api/v2/admin/tenants/:tenantId/memberships` return `pseudonymousId` (HMAC-derived per tenant) and `maskedSubject` ONLY — never raw `external_subject` — and every view writes `tenant.principals.viewed` to `platform_audit_event`. No unmasked customer-identifier endpoint exists on `/api/v2/admin/*` or `/api/v2/ops/*` (confirmed for DPO sign-off).
- **Platform-to-Tenant Boundary & Bootstrap Policy Gate:** Only `POST /api/v2/admin/tenants/:tenantId/memberships` writes tenant memberships from the admin plane; it restricts `domainRole` to `EMPLOYER_ADMIN` only, refuses self-assignment (`403`), refuses any subject in `platform_user` (`403`), and Super Admin tokens have zero access to tenant routes (`401`). *Residual policy gate for Product/Security Owner:* because an external non-staff subject can still be bootstrapped by a single Super Admin, decide whether pilot requires four-eyes + customer-consent ticket reference on `membership.bootstrap_tenant_admin` (or customer-initiated OIDC bootstrap).
- **Customer-Side Separation of Duties (Tenant Admin):** `EMPLOYER_ADMIN` alone cannot approve controls or set hazard dispositions (`403`), cannot self-assign or self-invite `APPROVER` or `RISK_OWNER` (`403` in `tenant-admin.ts`), non-approval self-assignments are explicitly tagged `self_assigned:true` in `audit_event`, and control owners cannot approve their own controls outside `local`/`test` (`requireSeparationOfDuties` in `domains/tenant/auth.ts`).
- **Mandatory Reason & Immutable Audit:** Every Super Admin write requires a free-text `reason` (min 5 chars; min 10 chars for offboarding). `platform_audit_event` records `operator`, `approver`, `role`, `action`, `target_type`, `target_id`, `reason`, `request_id`, and `step_up_verified` under an append-only DB trigger (`abate_ops` has zero grants on `platform_audit_event`); `POST /api/v2/admin/audit/export` logs `platform_audit.export` for every JSON/CSV export.
- **Preview Pack Lockdown:** `HEALTHCARE`, `ACCOUNTING`, `SOFTWARE_IT`, and `FINANCE` are refused (`403 FORBIDDEN`) on both admin and tenant HTTP routes and rendered disabled (`"preview, not enabled"`) in all selectors.

---

## 4. Verification References

- `backend/tools/test-super-admin.ts` (`npm --prefix backend run test-super-admin`)
- `backend/tools/test-admin-matrix.ts` (`npm --prefix backend run test-admin-matrix` — 43 endpoints × 6 actor tiers = 258 matrix assertions + privilege escalation + cross-tenant `404` parity + Tenant Admin lifecycle)
- `backend/tools/db-audit.ts` & `backend/tools/test-pg-parity.ts` (live PostgreSQL role isolation, `abate_ops` de-escalation, and `chk_four_eyes_distinct_approver` constraint checks)
- `tests/e2e/login-and-super-admin.spec.ts` & `tests/e2e/tenant-admin.spec.ts` (Playwright E2E + Axe WCAG 2.1 AA)

---

## 5. Approval Gate

- **Security Owner Sign-off:** `PENDING — DO NOT FILL BY AGENT`
- **DPO Sign-off (Pseudonymous Admin Principal Views):** `PENDING — DO NOT FILL BY AGENT`
- **Review Date:** `PENDING`
