# Abate — Phase 5: Jurisdiction Packs, Retention Schedules & Legal Hold

**Playbook package:** B5 (built from `adr/decisions-register.md`; the Phase 5 spec PDF was not available)
**Domain:** S11/S12 Lifecycle (`backend/src/domains/lifecycle/`)
**Date:** 29 October 2026
**Status:** Implemented and verified. Still needs to be checked against the official Phase 5 spec (see §6).

---

## 1. What the register required

| Register row | Requirement | Delivered |
|---|---|---|
| Initial Jurisdiction Packs | Effective-dated versioning; claims must match legal coverage | Versioned global catalog resolved by date; no pack in effect ⇒ retention refused and purges blocked |
| Retention Schedules | Tenant-configurable retention classes; legal hold override; verified tombstone deletion; **no universal duration invented by dev** | Tenant classes bounded by the pack; legal holds that override retention at both app and DB level; tombstone → delete → re-read verification. No default duration anywhere. |

## 2. Invariants enforced

1. **No invented duration.** A category with no ACTIVE class is never purged (`NO_POLICY` run, zero deletions).
2. **Bounded by the pack in effect.** A duration must lie within the pack's floor/ceiling and be at least 28 days (the Phase 3 minimum observation window; shorter retention would make every Privacy Release impossible).
3. **Fail closed when the rules change.** If a newer pack version puts the configured class out of bounds, or the tenant has no pack in effect, the run is `BLOCKED` and nothing is deleted.
4. **Legal hold overrides retention.** Enforced in `partitionForPurge` *and* by the `work_fact_purge_guard` trigger, so a buggy caller still cannot delete held data.
5. **Tombstone before delete.** The trigger refuses to delete a work fact unless a tombstone for it already exists. Each deletion is re-read; any miss rolls back the whole run.
6. **Tombstones hold no personal data.** They store a SHA-256 of the deleted row and an HMAC of its source key; never the pseudonym or the source record id.
7. **No resurrection.** If the source re-delivers a purged record, ingest matches the tombstone key digest and counts it as `duplicate`.
8. **Packs are platform content.** `abate_app` has SELECT only on `jurisdiction_pack`; there is no tenant API to write packs. Published versions are sequential, never overlap, and their content is immutable.
9. **Accountable owners only.** Setting retention, placing/releasing holds and running purges need `RISK_OWNER` or `EMPLOYER_ADMIN`.
10. **Same platform rules as other phases:** forced RLS on all tenant tables, idempotent `runCommand`, audit event and outbox event per command, counts-only run receipts.

## 3. Files

**Backend**
- `db/migrations/0050_retention_jurisdiction.sql`: `jurisdiction_pack`, `retention_class`, `legal_hold`, `retention_run`, `deletion_tombstone`, grants, and the purge-guard trigger. Applied and exercised on PostgreSQL 16.2 as `abate_app`.
- `src/contracts/retention.ts`: Zod schemas (`.strict()`) and view types.
- `src/domains/lifecycle/policy.ts`: pure rules (effective-dated resolution, publish planning, bounds, purge partition).
- `src/domains/lifecycle/jurisdiction.ts`: coverage, version listing, `publishPackVersion` (platform-side).
- `src/domains/lifecycle/retention.ts`: `setRetentionClass`, `placeLegalHold`, `releaseLegalHold`, `previewRetention`, `runRetention`, `getRetentionState`.
- `src/domains/work/record-key.ts`: keyed source-identity digest shared by ingest and retention.
- `src/domains/ingest/ingest-batch.ts`: refuses re-ingestion of tombstoned records.
- `src/platform/db/with-tenant.ts`: memory-engine tables, RLS regex, rollback snapshot, and trigger emulation.
- `src/fixtures/seed.ts`: tenant refs are now pack ids (`legal-uk-sra`, `legal-uk-bar`); a **synthetic** pack is published for Tenant A only.
- `src/index.ts`: routes below.

**Frontend**: `api/client.ts` (Phase 5 client); `components/Tabs/RetentionTab.tsx`; new tab in `App.tsx`.

## 4. API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v2/jurisdiction/coverage?at=ISO` | `COVERED` with pack, or `NOT_COVERED` |
| GET | `/api/v2/jurisdiction/pack-versions` | Effective-dated history of the tenant's pack |
| GET | `/api/v2/retention` | Coverage, classes, holds, runs, tombstone digests |
| GET | `/api/v2/retention/preview?dataCategory=WORK_FACT` | Dry run; no writes |
| POST | `/api/v2/retention/classes` | `Idempotency-Key` required |
| POST | `/api/v2/retention/runs` | `Idempotency-Key` required |
| POST | `/api/v2/legal-holds` | `Idempotency-Key` required; optional `scopeConnectionId` |
| POST | `/api/v2/legal-holds/:id/release` | `Idempotency-Key` required; second release ⇒ 409 |

## 5. Verification

- `npm --prefix backend run test-boundaries`: **32/32** (21 existing + 11 Phase 5). Mutation-checked: disabling the hold check or the tombstone guard each makes a test fail.
- `npm --prefix backend run test-fast`: 5/5. `npm --prefix backend run demo-cycle`: 14 steps, Phases 0–5.
- Migration 0050 applied to PostgreSQL 16.2 and exercised as `abate_app`: catalog write denied; delete without tombstone denied; delete under hold denied; tombstone rewrite denied; sanctioned purge succeeds; Tenant B sees 0 of Tenant A's tombstones.
- Browser check of the Phase 5 tab, including Tenant B fail-closed and the floor refusal.

Also fixed: `tools/demo-cycle.ts` called `runDemoCycle()` twice, so its second run reported "records accepted: 0".

## 6. Assumptions to check against the Phase 5 spec

1. Only `WORK_FACT` is purgeable. Audit events, releases, evidence packages and receipts are governance records and are not deleted; their retention needs the spec.
2. Fact age is measured from `end_at` (when the work happened), not `recorded_at`.
3. The 28-day measurement minimum is a system floor, separate from any legal floor.
4. Retention admin roles: `RISK_OWNER`, `EMPLOYER_ADMIN`.
5. A re-delivered purged record is counted as `duplicate` (no new receipt column).
6. Packs are published platform-side (`publishPackVersion` on a migrator connection); there is no HTTP route for it.
7. The seeded `legal-uk-sra` pack (floor 90 / ceiling 730 days) is **synthetic test data, not legal content**. `legal-uk-bar` is deliberately left unpublished.

## 7. Known limitations (unchanged from earlier phases)

- The running server and the seed use the in-memory engine; no Postgres-backed seed exists for any phase.
- The OpenAPI registry still covers only Phase 1 routes.
- Purges are run on demand (API/UI); no scheduler is wired.
