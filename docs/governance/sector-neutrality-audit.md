# Sector Neutrality Audit Table (`T-07` / `G-05` / Completion Plan §8)

> **Purpose**: Classifies every sector-specific term (`matter`, `practice area`, `trial`, `SRA`, `partner`, `S13`, and the Healthcare and Software & IT equivalents) across the repository as **CORE** or **PACK**, and documents what a tenant without a sector pack sees.
> **Scope Notice**: The UK Legal Sector Pack is the only launched commercial pack. The Healthcare and Software & IT packs are **previews**: selectable, but their regulatory content is pending the Legal & Policy Lead, and they are never claimed as launched. The `accounting-fixture` pack is an **architecture portability test fixture only**. See `ADR-006-sector-pack-registry.md`.
> **Enforcement**: `npm --prefix backend run lint:sector-neutrality` fails CI when legal-only wording appears outside the files listed in section 4.

---

## 1. Neutral Core vs. Pack Vocabulary Mapping

| Neutral Core Concept | Generic (`GENERIC`) | Legal (`LEGAL`, launched) | Healthcare (`HEALTHCARE`, preview) | Software & IT (`SOFTWARE_IT`, preview) | Accounting (`ACCOUNTING`, test fixture) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `workItem` | Work Item | Matter | Care Episode | Delivery Item | Engagement |
| `workItems` | Work Items | Matters | Care Episodes | Delivery Items | Engagements |
| `unit` | Unit / Team | Practice Area | Service Line | Squad | Service Line |
| `demandWindow` | Demand Window | Trial / Closing Window | Surge / Pressure Window | Release / Incident Window | Busy Season / Close Window |
| `supervisor` | Accountable Reviewer | Supervisory Partner | Clinical Lead | Engineering Manager | Engagement Reviewer |

---

## 2. Repository Term Classification (`CORE` vs. `PACK`)

| Term / Symbol | Location(s) | Classification | Verification / Status |
| :--- | :--- | :--- | :--- |
| `matter`, `practiceArea`, `TRIAL_PREP`, `CLOSING_TRANSACTION`, `SRA`, `Supervisory Partner` | `backend/src/domains/lifecycle/packs/legal.ts`, `backend/src/domains/sector-legal/*` | **PACK** (`legal-uk-sra`) | Legal wording lives only in the legal pack and its field-name adapter. Legal-named alias routes (`/api/v2/sector/legal/*`) return `403 FORBIDDEN` for non-legal tenants. |
| Sector screen wording (headings, badges, decoy fields, consultation actions) | `ui` block of each pack definition, delivered by `GET /api/v2/tenant/sector-profile` | **PACK** | `frontend/src/components/Tabs/SectorPackTab.tsx` and `SectorPackSelector.tsx` contain no sector wording. Verified by `frontend/tests/sector-pack.test.tsx`. |
| `S13` | `docs/governance/be-spec-reconciliation.md` | **PACK extension** (recorded as sector extension, not a new core domain — `G-34`) | Core domains remain `S01`–`S12` (`ConstitutionalTab.tsx`). |
| `workItem`, `unit`, `demandWindow`, `supervisor`, `evaluateNeutralFatigueSurge()`, `evaluateSectorFatigue()` | `backend/src/domains/lifecycle/sector.ts`, `backend/src/domains/sector-work/`, `frontend/src/utils/vocabulary.ts` | **CORE** | Sector-neutral rules read from the active pack (`cannotOverride: ["privacyFloor", "aiAuthority"]`). |
| Hold reference (`caseRef`; deprecated alias `matterRef`; DB column `matter_ref`) | `backend/src/contracts/retention.ts`, `backend/db/migrations/0050_retention_jurisdiction.sql`, `RetentionTab.tsx` | **CORE** (legacy column name; API and UI use the neutral case reference) | Column kept for migration stability. Verified by `backend/tools/test-hold-reference.ts`. |
| `legal-uk-sra`, `legal-uk-bar`, `sector-legal` | `backend/src/fixtures/seed.ts` | **FIXTURE / PACK** | Synthetic seed fixtures for Tenant A / Tenant B. Tenants choose a pack via `tenant_sector_setting` (`GET/PUT /api/v2/tenant/sector-profile`) or the `Sector Pack` card in the Organizations tab. |
| Core forbidden fields: `substantiveWorkProduct`, `individualScore`, `keystrokeLogs` | `backend/src/domains/lifecycle/sector-pack.ts` (`CORE_FORBIDDEN_FIELDS`) | **CORE** | Inherited by every pack and cannot be dropped. |
| Sector forbidden fields (`clientConfidentialNotes`, `patientIdentifier`, `sourceCode`, `individualVelocity`, ...) | each pack definition | **PACK** (additive only) | Packs may only **add** forbidden fields. Verified per sector in `backend/tools/test-sector-work.ts`. |
| People nouns used by the prohibited-request screen | `backend/src/domains/ai/run.ts` | **CORE** (covers every sector) | Refuses ranking-style requests about a nurse, engineer or accountant as it does about a lawyer. Verified in `backend/tools/test-phase6-ai.ts`. |

---

## 3. What a Tenant Without a Sector Pack Sees (Verified by E2E & Backend Tests)
1. **Navigation**: the sector tab is hidden (`count === 0`, verified by `tests/e2e/responsive-and-sector-neutral.spec.ts`).
2. **Backend Isolation**: calling `GET /api/v2/sector/work-items`, `POST /api/v2/sector/work-items/map`, or `POST /api/v2/sector/work-items/fatigue-check` as a `GENERIC` tenant returns `403 FORBIDDEN`. The legal-named aliases do the same.
3. **Vocabulary**: the UI renders `Work Item`, `Unit / Team`, `Demand Window`, and `Accountable Reviewer` from `GET /api/v2/tenant/sector-profile`.
4. **Portability Proof**: `backend/tools/test-sector-registry.ts` registers a synthetic sector at runtime and shows it resolves, validates and renders with no resolver, route or screen change. `backend/tools/test-sector-work.ts` switches a tenant through Healthcare and Software & IT over the same routes. `validateSectorPack()` rejects any pack attempting `privacyFloor < 10` or `aiAuthority: "EXPANDED"`.
5. **Retention**: a tenant with no approved jurisdiction pack for its sector has no retention policy, and nothing is deleted until one is configured.

---

## 4. Files Allowed to Contain Legal Wording

The list is the `ALLOWED` table in `backend/tools/lint-sector-neutrality.ts`, each entry with its reason. The lint also fails when an entry no longer contains any legal wording, so the list can only shrink.
