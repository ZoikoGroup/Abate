# ADR-005: Per-Tenant AI Quota, Sector Neutrality, and Connector State Labels

- **Status:** Accepted
- **Date:** 2026-11-18
- **Owners:** Platform Architecture & Governance

## 1. Per-Tenant AI Monthly Quota
- **Quota Store & Scope:** `monthly_budget_minor` lives in `ai_use_case` (write-revoked from `abate_app`; code fallback `100000`). Spend is derived per tenant as `SUM(cost_minor)` in `ai_run` since the start of the current UTC calendar month.
- **Concurrency & Tenant Isolation:** `lockBudget()` acquires transaction-scoped `pg_advisory_xact_lock(hashtextextended('ai-budget:' || tenant_id || ':' || use_case_key, 0))` under `SET LOCAL lock_timeout = '10000ms'` inside `withTenant()`, preventing concurrent requests in the same tenant from overshooting the remaining budget while never blocking other tenants.
- **Counted Runs Policy:** All persisted `ai_run` rows (`PROPOSED`, `ACCEPTED`, `DISCARDED`, and `REJECTED_BY_VALIDATOR`) count toward monthly spend because the provider call already occurred. Pre-model constitutional refusals (`assertNotProhibitedRequest`) and rolled-back errors write zero rows and do not consume quota.
- **Idempotency:** `POST /api/v2/ai/explain-release`, `/api/v2/ai/draft-cause`, and `/api/v2/ai/draft-control` accept `Idempotency-Key` via `runCommand()`, guaranteeing retries with identical payloads return the original run without consuming a second quota slot (and mismatched payloads return `409 CONFLICT`).
- **Over-Limit Response & Precedence:** Exceeding budget returns HTTP `429 RATE_LIMITED` with a `Retry-After` header (seconds until next UTC month start) and calm UI guidance pointing to the manual workflow. Independent kill switches (`all_ai`, `use_case:*`, `model:*`, `provider:*`) are checked before quota and override everything (`503 UNAVAILABLE`).

## 2. Sector-Neutral Core & Legal Sector Pack Contract
- **Neutral Core:** Work-design entities use neutral core concepts (`WORK_ITEM`, `unit`, `demand_window`, `accountable_reviewer`, `evaluateNeutralFatigueSurge`). Legal terms (`Matter`, `Practice Area`, `Trial Prep`, `Supervisory Partner`, SRA thresholds) belong solely in the Legal Sector Pack (`legalMapping` + `domains/sector-legal/`).
- **Per-Tenant Pack Gating:** `GET /api/v2/tenant/sector-profile` resolves active `tenant_policy_binding` records for the tenant. Legal UI (`LegalPracticeTab` + fatigue panel in `HazardControlTab`) renders only when `hasLegalPack === true`, and `/api/v2/sector/legal/*` endpoints fail closed (`403 FORBIDDEN`) for tenants without a Legal binding.
- **Truthful Scope & Guardrails:** Abate is framed as sector-neutral work-design infrastructure for regulated knowledge-work teams, with the UK Legal Sector Pack (SRA 2023) active today. `validateSectorPack()` blocks any pack attempting to lower `privacyFloor` (`< 10`) or set `aiAuthority = "EXPANDED"`.

## 3. Connection State Model (`SUSPENDED` / `RESUMED` vs. Terminal `DISCONNECTED`)
- **Reversible vs. Terminal:** `connection.state` supports reversible states (`ACTIVE`, `PAUSED`, `SUSPENDED`, `RESUMED`) and terminal states (`DISCONNECTED`, plus legacy `REVOKED`) via migration `0084_completion_roles_rls_constraints.sql`.
- **API & UI Mapping:** `POST /api/v2/connections/:id/suspend` transitions to `SUSPENDED` (displayed as `Suspended`, reversible via `POST /api/v2/connections/:id/resume` -> `RESUMED`), while `POST /api/v2/connections/:id/disconnect` transitions permanently to terminal `DISCONNECTED` behind a confirmation dialog.
