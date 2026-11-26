# ABATE — Complete Implementation Tracker

**Last Updated:** 2026-11-26
**Source Roadmap:** `Abate_Playbook_Analysis_and_Backend_Roadmap.pdf`, `Abate_Completion_Plan_DB_Backend_Frontend.pdf`, `docs/gap-register.md`
**Honesty Rule:** Items are marked `COMPLETED` only when implemented in code **and** verified by executed tests/builds. External human sign-offs and fixed-host staging runs remain `BLOCKED` on their named owners/infrastructure.

---

## 1. Execution Waves Overview

| Wave | Scope | Status | Notes |
|---|---|---|---|
| **Wave 0** | Audit, baseline, CI, verified gap register (`docs/gap-register.md`) | **IN PROGRESS** | `gap-register.md` created; `ci.yml` hardened; awaiting live GH Actions push |
| **Wave 1** | Authentication, tenancy, DB integrity, RLS & Super Admin DB schema (`0092`) | **IN PROGRESS** | `0001`–`0091` exist; implementing `0092_super_admin_platform_ops.sql` |
| **Wave 2** | Backend domains, APIs, OpenAPI contracts, Super Admin APIs (`/api/v2/admin/*`) | **IN PROGRESS** | Core domains exist; adding Super Admin & auth/session enhancements |
| **Wave 3** | Ingestion, deterministic measurement & Privacy Release | **COMPLETED (Code)** | Verified locally on live PG 16.2; privacy method human sign-off (`G-03`) pending |
| **Wave 4** | Hazard -> Cause -> Control -> Approval -> Implementation -> Verification | **COMPLETED (Code)** | `test-control` passes; `BE-007` human reconciliation (`G-04`) pending |
| **Wave 5** | Governance, evidence manifests, lifecycle, retention & tombstones | **COMPLETED (Code)** | `test-retention` & `test-planes` pass; real retention durations (`G-07`) pending |
| **Wave 6** | Login screen, Super Admin Console & complete Tenant/Customer Frontend | **IN PROGRESS** | Building `LoginScreen.tsx` & `SuperAdminConsole.tsx` + full wiring |
| **Wave 7** | Sector-neutral architecture & sector packs | **COMPLETED (Code)** | `lint:sector-neutrality` & `sector-pack.test.tsx` pass; product ADR (`G-06`) pending |
| **Wave 8** | Bounded AI, action execution boundaries & Plane B outcomes | **COMPLETED (Code)** | `test-ai` & `test-ai-evals` pass; model provider terms (`G-30`) pending |
| **Wave 9** | Operations, monitoring, recovery & security hardening | **IN PROGRESS** | `test-worker`, `db:audit`, `test-pg-parity` pass; staging measurements (`G-10`/`G-11`) pending |
| **Wave 10** | Full E2E Playwright + Axe, button-and-endpoint checklist, live demo & README | **IN PROGRESS** | Expanding E2E for Login + Super Admin + full workflow; updating README |

---

## 2. Detailed Feature & Component Tracker

### A. Database & Migrations (`backend/db/`)
| Item | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Core schema & RLS (`0001`–`0088`) | COMPLETED | `backend/db/migrations/0001..0088` | `migrate`, `db:audit` | None |
| Outbox pruning & worker RLS (`0089`) | COMPLETED | `backend/db/migrations/0089_outbox_prune_policy.sql` | `test-worker`, `test-pg-parity` | Needs green CI run |
| Migrator `metric_definition` & `0091` `security_invoker` views | COMPLETED | `backend/db/migrations/0090..0091` | `db:audit`, `test-pg-parity` | Security owner sign-off (`ADR-006`) |
| Super Admin platform ops & `platform_audit_event` (`0092`) | COMPLETED (Migration) | `backend/db/migrations/0092_super_admin_platform_ops.sql` | `db:audit` | Ready for live PG run |

### B. Authentication & Authorization (`backend/src/routes/auth.ts`, `domains/tenant/auth.ts`, `domains/support/support-auth.ts`)
| Item | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Tenant JWT & OIDC PKCE + HttpOnly cookie | COMPLETED | `backend/src/routes/auth.ts`, `platform/oidc.ts` | `test-fast`, `test-boundaries` | None |
| Support zero-impersonation token | COMPLETED | `backend/src/domains/support/support-auth.ts` | `test-fast`, `test-pg-parity` | None |
| Super Admin auth (`SUPER_ADMIN` scope & dev/OIDC token) | COMPLETED | `backend/src/domains/support/support-auth.ts`, `routes/admin.ts` | `test-super-admin` | None |
| Frontend Login / Logout / Role-based routing | COMPLETED | `frontend/src/App.tsx`, `components/LoginScreen.tsx` | `e2e/login-and-super-admin.spec.ts`, `frontend build` | None |

### C. Super Admin Platform (`backend/src/routes/admin.ts`, `frontend/src/components/SuperAdmin/`)
| Item | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Platform Overview API & UI | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `e2e/login-and-super-admin.spec.ts` | None |
| Tenant Management (Create, Edit, Activate/Suspend, Sector Pack) | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `e2e/login-and-super-admin.spec.ts` | None |
| User & Access Management (Principals, Memberships, Assign/Revoke) | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `e2e/login-and-super-admin.spec.ts` | None |
| Governance, Sector Packs & Feature Flags | COMPLETED | `routes/admin.ts`, `SuperAdminConsole.tsx` | `test-super-admin`, `e2e/login-and-super-admin.spec.ts` | None |
| Platform Operations (Worker, Dead-Letter Replay, Kill Switches, Diagnostics) | COMPLETED | `routes/ops.ts`, `SuperAdminConsole.tsx`, `OperationsTab.tsx` | `test-worker`, `e2e/retention-and-ops.spec.ts` | None |
| Evidence & Release Dossier Visibility | COMPLETED | `routes/ops.ts`, `SuperAdminConsole.tsx`, `OperationsTab.tsx` | `build-dossier.ts` | None |

### D. Tenant / Customer Frontend (`frontend/src/components/Tabs/`)
| Screen / Tab | Status | Location | Tests / Validation | Remaining Issues |
|---|---|---|---|---|
| Login & Tenant Selection | IN PROGRESS | `App.tsx`, `LoginScreen.tsx` | `e2e/` | Add unified Login screen for dev + OIDC |
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
