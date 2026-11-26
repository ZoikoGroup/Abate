# ADR-006: Operational Views via PostgreSQL `security_invoker` & Column-Level Grants

- **Status:** `PROPOSED — PENDING SECURITY OWNER APPROVAL`
- **Date:** 2026-11-26
- **Context:** Migrations `0087`, `0088`, `0090`, `0091`, and `backend/db/init/01-roles.sql`

---

## 1. Context

Two operational views exist to give `abate_ops` and `abate_worker` non-PII discovery of active tenants and connector synchronization health:
1. `ops_active_tenants` (`0087`): Projects `(id, region, 'ACTIVE')` from `tenant`.
2. `ops_connector_health` (`0088`): Projects `(id, source, state, last_success_at, expected_cadence_seconds)` from `connection`.

Both `tenant` and `connection` enforce `FORCE ROW LEVEL SECURITY` (`0084`). Because views in PostgreSQL execute as the **view owner** (`abate_migrator`) by default, live non-superuser runs showed both views returning zero rows.

Migration `0090` initially mitigated this by granting `abate_migrator` cross-tenant `SELECT` RLS policies (`tenant_migrator_ops_view_read`, `connection_migrator_ops_view_read`) on `tenant` and `connection`. Security review flagged that giving the DDL migration credential `SELECT` across all rows in `tenant` and `connection` widens the blast radius of a leaked migrator credential.

---

## 2. Decision

1. **Leave Migration `0090` Immutable:** Migration checksums are verified by `migrate.ts`. `0090` is not altered.
2. **Apply Migration `0091` (`0091_ops_views_security_invoker.sql`):**
   - Drop `tenant_migrator_ops_view_read` and `connection_migrator_ops_view_read` from `abate_migrator` (migrator returns to **zero** read access on `tenant` and `connection`).
   - Alter both `ops_active_tenants` and `ops_connector_health` to set **`WITH (security_invoker = true)`**.
   - Grant **column-level `SELECT` only** on non-sensitive fields:
     - `GRANT SELECT (id, region) ON tenant TO abate_ops, abate_worker;`
     - `GRANT SELECT (id, source, state, last_success_at, expected_cadence_seconds) ON connection TO abate_ops;`
   - Add narrow cross-tenant `SELECT` RLS policies (`tenant_ops_active_view_read` and `connection_ops_health_view_read`) for those runtime roles.
3. **PostgreSQL Engine Version Pin:** Using `ALTER VIEW ... SET (security_invoker = true)` strictly requires **PostgreSQL 15+** (production and CI target PostgreSQL 16.2).
4. **Migrator `NOCREATEDB` Policy:** `abate_migrator` retains `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. Database creation (`abate`, `abate_upgrade`) is handled exclusively by the setup/infrastructure admin (`abate_admin` in CI, cloud control plane in staging/production). The `db:audit` check covers **all** `abate_*` application and migrator roles equally.

---

## 3. Security Trade-offs & Residual Risk

- **Accepted Trade-off (`PENDING SECURITY OWNER APPROVAL`):** Because `security_invoker = true` evaluates permissions and RLS under the caller (`abate_ops` / `abate_worker`), those roles hold column-level `SELECT` grants and `USING (true)` RLS policies on the whitelisted columns directly (not exclusively via the view).
- **Blast Radius Boundary:**
  - `abate_ops` and `abate_worker` can query `(id, region)` directly on `tenant`, and `abate_ops` can query `(id, source, state, last_success_at, expected_cadence_seconds)` directly on `connection`.
  - Sensitive columns (`tenant.name`, `tenant.jurisdiction_config_ref`, `connection.tenant_id`, `connection.contract_id`) remain strictly denied (`permission denied`).
  - `abate_migrator` has zero read access to `tenant` and `connection`.
- **Alternative Considered:** Dedicated view-owner role (`abate_ops_view_owner`) owning the two views under default invoker security. Reversible in a future migration (`0092`) if the Security Owner prefers view ownership isolation over column-level grants.

---

## 4. Approval Gate

- **Security Owner Sign-off:** `PENDING — DO NOT FILL BY AGENT`
- **Review Date:** `PENDING`
