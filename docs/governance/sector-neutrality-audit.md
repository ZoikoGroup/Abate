# Sector Neutrality Audit Table (`T-07` / `G-05` / Completion Plan §8)

> **Purpose**: Classifies every legal-domain term (`matter`, `fee earner`, `practice area`, `trial`, `closing`, `SRA`, `partner`, `S13`) across the repository as **CORE** or **PACK**, and documents what a tenant without the Legal Sector Pack sees.
> **Scope Notice**: UK Legal Sector Pack is the only commercially enabled launch pack. The `accounting-fixture` pack in `backend/src/domains/lifecycle/sector.ts` is an **architecture portability test fixture only**, not a launched commercial sector.

---

## 1. Neutral Core vs. Pack Vocabulary Mapping

| Neutral Core Concept | Generic Tenant (`GENERIC`) | Legal Pack (`LEGAL` / `legal-uk-sra`) | Accounting Fixture (`ACCOUNTING` — test only) |
| :--- | :--- | :--- | :--- |
| `workItem` | Work Item | Matter | Engagement |
| `workItems` | Work Items | Matters | Engagements |
| `unit` | Unit / Team | Practice Area | Service Line |
| `demandWindow` | Demand Window | Trial / Closing Window | Busy Season / Close Window |
| `supervisor` | Accountable Reviewer | Supervisory Partner | Engagement Reviewer |
| `afterHoursPattern` | Evening work before deadline | Evening drafting before trial | Evening work before filing deadline |

---

## 2. Repository Term Classification (`CORE` vs. `PACK`)

| Term / Symbol | Location(s) | Classification | Verification / Status |
| :--- | :--- | :--- | :--- |
| `matter`, `practiceArea`, `TRIAL_PREP`, `CLOSING_TRANSACTION`, `SRA`, `Supervisory Partner` | `backend/src/domains/sector-legal/*`, `frontend/src/components/Tabs/LegalPracticeTab.tsx` | **PACK** (`legal-uk-sra`) | Isolated behind `assertTenantHasLegalPack()` on backend (`403 FORBIDDEN` for non-legal tenants) and `sectorProfile?.hasLegalPack` tab guard in `App.tsx`. |
| `S13` | `docs/governance/be-spec-reconciliation.md`, `LegalPracticeTab.tsx` | **PACK extension** (recorded as sector extension, not a new core domain — `G-34`) | Core domains remain `S01`–`S12` (`ConstitutionalTab.tsx`). |
| `workItem`, `unit`, `demandWindow`, `supervisor`, `evaluateNeutralFatigueSurge()` | `backend/src/domains/lifecycle/sector.ts`, `frontend/src/utils/vocabulary.ts` | **CORE** | Sector-neutral math; packs supply display terms and demand window names only (`cannotOverride: ["privacyFloor", "aiAuthority"]`). |
| `matter_ref` (DB column on `legal_hold`) | `backend/db/migrations/0050_retention_jurisdiction.sql`, `RetentionTab.tsx` | **CORE** (legacy column name; UI label is neutral `"Work item / Hold reference"`) | Column kept for migration stability; UI renders neutral label. |
| `legal-uk-sra`, `legal-uk-bar`, `sector-legal` | `backend/src/fixtures/seed.ts` | **FIXTURE / PACK** | Synthetic seed fixtures for Tenant A / Tenant B; tenants configure active pack via `tenant_sector_setting` (`GET/PUT /api/v2/tenant/sector-profile`). |
| `substantiveWorkProduct`, `clientConfidentialNotes` | `backend/src/domains/lifecycle/sector.ts`, `backend/src/contracts/legal-sector.ts` | **PACK** (additive forbidden fields) | Packs may only **add** forbidden fields; never relax core minimization rules (`keystrokes`, `screenshots`, `emails`, `individualScore`). |

---

## 3. What a Generic-Pack Tenant Sees (Verified by E2E & Backend Tests)
1. **Navigation**: `Legal Sector Pack (SRA 2023)` tab is hidden (`count === 0`, verified by `tests/e2e/responsive-and-sector-neutral.spec.ts`).
2. **Backend Isolation**: Calling `GET /api/v2/sector/legal/matters`, `POST /api/v2/sector/legal/matters/map`, or `POST /api/v2/sector/legal/fatigue-check` as a `GENERIC` tenant returns `403 FORBIDDEN`.
3. **Vocabulary**: UI renders `Work Item`, `Unit / Team`, `Demand Window`, and `Accountable Reviewer` from `GET /api/v2/tenant/sector-profile`.
4. **Portability Proof**: `backend/tools/test-sector-legal.ts` and `backend/tools/test-pg-parity.ts` verify two tenants in the same region (`eu-west-2`) with different sector packs resolve distinct vocabularies, demand windows, and gates without code branches, and `validateSectorPack()` rejects any pack attempting `privacyFloor < 10` or `aiAuthority: "EXPANDED"`.
