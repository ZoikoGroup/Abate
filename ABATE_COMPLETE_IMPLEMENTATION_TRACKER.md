# ABATE — Complete Implementation Tracker

**Last Updated:** 2026-11-27
**Source Roadmap:** `Abate_Playbook_Analysis_and_Backend_Roadmap.pdf`, `Abate_Completion_Plan_DB_Backend_Frontend.pdf`, `docs/gap-register.md`, `docs/architecture/ADR-007-admin-model-stepup-foureyes.md`
**Honesty Rule:** Items are marked `COMPLETED` only when implemented in code **and** verified by executed tests/builds. Local verification on 2026-11-27 ran against BOTH `memDb` and an isolated Docker **PostgreSQL 16.2 (`postgres:16.2-alpine`)** instance using all 10 non-superuser runtime roles from `backend/db/init/01-roles.sql`. GitHub Actions CI runs upon push; external human sign-offs and fixed-host staging runs remain `BLOCKED` on their named owners/infrastructure.

---

## 1. Execution Waves Overview

| Wave | Scope | Status | Notes |
|---|---|---|---|
| **Wave 0** | Audit, baseline, CI (`test-super-admin` & `test-admin-matrix` wired into both live-PG and offline jobs), merge hygiene | **COMPLETED (Local Live PG 16.2)** | `.gitignore` cleaned; `ci.yml` runs `abate_platform_admin` checks + both admin suites; awaiting GitHub Actions CI run after push |
| **Wave 1** | Authentication, tenancy, DB integrity, RLS & dedicated `abate_platform_admin` role (`0092`–`0094`) | **COMPLETED (Local Live PG 16.2)** | Verified on live PG 16.2 (`0001..0094` clean & `0001..0083 -> 0094` upgrade): `verify-pg` (`6/6`), `db:audit -- --require-live` (`14/14` queries, `0` violations), `test-pg-parity -- --require-live` (`17/17`) |
| **Wave 2** | Backend domains, OpenAPI (`157` paths), hardened Super Admin (`/api/v2/admin/*`) & Tenant Admin (`/api/v2/tenant-admin/*`) | **COMPLETED (Local Live PG 16.2)** | Real OIDC `amr`/`auth_time` step-up (`POST /api/v2/admin/session/oidc/exchange` + hardened `/step-up`), four-eyes (`202`/`403`/`409`) + min-2 deadlock guard (`409`), `SameSite=Strict` admin cookies + CSRF (`403`), preview pack lockdown (`403`), cross-tenant revoke `404`, Tenant Admin self-assign `APPROVER`/`RISK_OWNER` refusal (`403`), `generate:openapi -- --check` `0` drift |
| **Wave 3** | Ingestion, deterministic measurement & Privacy Release | **COMPLETED (Code)** | `test-ingest` & `test-privacy` pass; privacy method human sign-off (`G-03`) pending |
| **Wave 4** | Hazard -> Cause -> Control -> Approval -> Implementation -> Verification | **COMPLETED (Code)** | `test-control` passes; `EMPLOYER_ADMIN` refused `403` on approval & disposition; control owner cannot approve own control outside local/test; `BE-007` human reconciliation (`G-04`) pending |
| **Wave 5** | Governance, evidence manifests, lifecycle, retention & tombstones | **COMPLETED (Code)** | `test-retention` & `test-planes` pass; real retention durations (`G-07`) pending |
| **Wave 6** | Login screen, hardened Super Admin Console, Tenant Admin Console & complete Customer Frontend | **COMPLETED (Local Live PG 16.2)** | `SuperAdminConsole.tsx`, `TenantAdminTab.tsx`, `AdminDialogs.tsx`; `oxlint` `0 warnings and 0 errors`; `frontend test` & `build` green |
| **Wave 7** | Sector-neutral architecture & preview-pack lockdown | **COMPLETED (Code)** | `lint:sector-neutrality` (`0` violations), `sector-pack.test.tsx` (preview disabled); product ADR (`G-06`) pending |
| **Wave 8** | Bounded AI, action execution boundaries & Plane B outcomes | **COMPLETED (Code)** | `test-ai` & `test-ai-evals` pass; `/api/v2/ops/ai-quota` content-free (`withOps` only); model provider terms (`G-30`) pending |
| **Wave 9** | Operations, monitoring, recovery & security hardening | **COMPLETED (Code; Docs `DRAFT`)** | `ADR-007` (`DRAFT`), `docs/runbooks/platform-admin-lifecycle.md` (`DRAFT`), `docs/runbooks/tenant-suspension-and-offboarding.md` (`DRAFT`); Security Owner / DPO sign-offs & staging measurements (`G-10`/`G-11`) pending |
| **Wave 10** | Full E2E Playwright + Axe (`50/50` on live Docker PG 16.2), button-and-endpoint checklist & live demo | **COMPLETED (Local Live PG 16.2)** | `50/50` Playwright + Axe passed on live Docker PostgreSQL 16.2 (`ABATE_REQUIRE_PG=1`, non-superuser roles, `3.0m`); GitHub Actions CI run pending push |

---

## 2. Detailed Feature & Component Tracker

### A. Database & Migrations (`backend/db/`)
| Item | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Core schema & RLS (`0001`–`0088`) | COMPLETED | `backend/db/migrations/0001..0088` | `migrate`, `db:audit` | None |
| Outbox pruning & worker RLS (`0089`) | COMPLETED | `backend/db/migrations/0089_outbox_prune_policy.sql` | `test-worker`, `test-pg-parity` | Needs green CI run |
| Migrator `metric_definition` & `0091` `security_invoker` views | COMPLETED | `backend/db/migrations/0090..0091` | `db:audit`, `test-pg-parity` | Security owner sign-off (`ADR-006`) |
| Super Admin platform ops & `platform_audit_event` (`0092`–`0093`) | COMPLETED (Migration) | `backend/db/migrations/0092..0093` | `db:audit`, `test-pg-parity` | Live PG runs in CI |
| Dedicated `abate_platform_admin`, `abate_ops` de-escalation, `admin_approval_request`, `platform_user`, `tenant_ai_quota_config`, `tenant_entitlement`, `tenant_invitation` (`0094`) | COMPLETED (Local Live PG 16.2) | `backend/db/migrations/0094_platform_admin_role_and_governance.sql` | Live PG 16.2 (`0001..0094` clean + `0001..0083 -> 0094` upgrade), `db:audit -- --require-live` (`14/14`, `0` violations), `test-pg-parity -- --require-live` (`17/17`) | GitHub Actions CI run after push; `ADR-007` Security Owner sign-off pending |

### B. Authentication & Authorization (`backend/src/routes/auth.ts`, `domains/tenant/auth.ts`, `domains/support/support-auth.ts`)
| Item | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Tenant JWT & OIDC PKCE + HttpOnly cookie | COMPLETED | `backend/src/routes/auth.ts`, `platform/oidc.ts` | `test-fast`, `test-boundaries`, `e2e/pilot-oidc.spec.ts` | None |
| Support zero-impersonation token | COMPLETED | `backend/src/domains/support/support-auth.ts` | `test-fast`, `test-admin-matrix`, `test-pg-parity` | None |
| Hardened Super Admin auth (`SameSite=Strict` cookie + CSRF + short TTL + IP allowlist + real OIDC `amr`/`auth_time` step-up + four-eyes + min-2 deadlock guard) | COMPLETED (Local Live PG 16.2) | `backend/src/domains/support/support-auth.ts`, `routes/admin.ts` | Live PG 16.2 `test-super-admin` (`13/13`), `test-admin-matrix` (`5/5`, `258` assertions) | `ADR-007` Security Owner & `ADMIN_IP_ALLOWLIST` staging/pilot decision pending |
| Tenant Admin separation (`EMPLOYER_ADMIN` excluded from `APPROVAL_ROLES`, suspended tenant & deactivated principal refusal) | COMPLETED | `backend/src/domains/tenant/auth.ts`, `routes/control.ts`, `routes/tenant-admin.ts` | `test-admin-matrix`, `e2e/tenant-admin.spec.ts` | None |
| Frontend Login / Logout / Role-based routing | COMPLETED | `frontend/src/App.tsx`, `components/LoginScreen.tsx` | `e2e/login-and-super-admin.spec.ts`, `frontend build` | None |

### C. Super Admin Platform (`backend/src/routes/admin.ts`, `frontend/src/components/SuperAdmin/`)
| Item | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Platform Overview & `/api/v2/admin/me` Server-Driven Nav | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `e2e/login-and-super-admin.spec.ts` | None |
| Tenant Management (Create, Edit `If-Match`, Four-Eyes Suspend, Activate, Four-Eyes Offboard, Launched/Baseline Sector Pack) | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `test-admin-matrix`, `e2e/login-and-super-admin.spec.ts` | None |
| Platform Users & Four-Eyes Approval Queue | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx`, `AdminDialogs.tsx` | `test-super-admin`, `test-admin-matrix`, `e2e/login-and-super-admin.spec.ts` | None |
| Tenant User & Access Management (Pseudonymous/Masked + Audited View + `EMPLOYER_ADMIN`-Only Bootstrap) | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `test-admin-matrix`, `e2e/login-and-super-admin.spec.ts` | DPO sign-off (`ADR-007`) pending |
| Governance, Preview-Pack Lockdown, Feature Flags, Entitlements & AI Quotas | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx`, `SectorPackSelector.tsx` | `test-super-admin`, `sector-pack.test.tsx`, `e2e/login-and-super-admin.spec.ts` | None |
| Platform Operations, Governed Kill Switches, Immutable Audit & Audited Export | COMPLETED | `routes/admin.ts`, `routes/ops.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `test-worker`, `e2e/login-and-super-admin.spec.ts` | None |
| Evidence & Release Dossier Visibility (Strictly Read-Only, Zero Ratify Action) | COMPLETED | `routes/ops.ts`, `SuperAdminConsole.tsx`, `OperationsTab.tsx` | `e2e/login-and-super-admin.spec.ts`, `build-dossier.ts` | Release Authority human sign-off (`sign-dossier`) |

### D. Tenant / Customer Frontend (`frontend/src/components/Tabs/`)
| Screen / Tab | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Login & Tenant Selection | COMPLETED | `App.tsx`, `LoginScreen.tsx` | `e2e/login-and-super-admin.spec.ts`, `e2e/pilot-oidc.spec.ts` | None |
| Tenant Admin Console (Users, Effective-Dated Roles, OIDC Invites, Orgs, Connections, Sector Settings, Lifecycle, Own Audit, Usage) | COMPLETED | `TenantAdminTab.tsx`, `routes/tenant-admin.ts` | `test-admin-matrix`, `e2e/tenant-admin.spec.ts`, `a11y/pages.spec.ts` | None |
| Dashboard | COMPLETED | `DashboardTab.tsx` | `components.test.tsx` | Verify all links/actions |
| Organizations | COMPLETED | `OrganizationsTab.tsx` | `e2e/live-demo-console.spec.ts` | Verify checklist |
| Connections / Ingestion | COMPLETED | `IngestionTab.tsx` | `e2e/` | Verify Suspend/Resume/Disconnect |
| Analytics / Privacy Release | COMPLETED | `CohortAnalyticsTab.tsx` | `e2e/` | Verify CSV export & suppression |
| Hazards & Controls | COMPLETED | `HazardControlTab.tsx` | `components.test.tsx` | Verify full 21-step workflow |
| Evidence & Audit Verifier | COMPLETED | `AuditTab.tsx`, `AuditVerifierTab.tsx` | `e2e/` | Verify download & Merkle check |
| Retention, Holds, Rights | COMPLETED | `RetentionTab.tsx` | `e2e/retention-and-ops.spec.ts` | Verify placeholder labels |
| Policy & Sector Packs | COMPLETED | `SectorPackTab.tsx` | `sector-pack.test.tsx` | Verify tab visibility |
| Bounded AI Panel | COMPLETED | `BoundedAiTab.tsx`, `AiPanel.tsx` | `test-ai` | Verify fallback when disabled |
| Outcomes (Plane B) & AI Change | COMPLETED | `OutcomesAiChangeTab.tsx` | `test-planes` | Verify flag gating |
| Operations Console | COMPLETED | `OperationsTab.tsx` | `components.test.tsx` | Cross-link with Super Admin |
| Live Demo Console | COMPLETED | `LiveDemoConsole.tsx` | `e2e/live-demo-console.spec.ts` | Verify full workflow end-to-end |

### E. Blockers Requiring Human / External Infrastructure
| Blocker | Gate / Gap | Owner | Status |
|---|---|---|---|
| Privacy method decision (deterministic suppression vs calibrated noise) | G3 / G-03 | Privacy Owner | BLOCKED (Human Decision) |
| `BE-001`–`010` spec reconciliation | G9 / G-04 | Architecture Owner | BLOCKED (Human Review) |
| Legal wording & real retention durations | G9 / G-07 | Legal / Data Owners | BLOCKED (Human Sign-Off) |
| Sector scope ADR ("all professionals") | G5 / G-06 | Product Owner | BLOCKED (Human Decision) |
| Jurisdiction pack content reviews | G9 / G-29 | Sector Legal Counsel | BLOCKED (Human Review) |
| Model provider terms & region | G9 / G-30 | Legal & Product | BLOCKED (Human Sign-Off) |
| Fixed staging host, OIDC, KMS, S3, measured SLO/RTO/RPO | G6, G7 / G-08..11, G-20, G-22, G-25 | Infra / Ops | BLOCKED (Staging Host) |
| Independent challenge by non-builder | G8 / G-12, G-31 | External Reviewer | BLOCKED (External Reviewer) |
| Release dossier human sign-off (`sign-dossier`) | G10 / G-27 | Release Authority | BLOCKED (Human Sign-Off) |
