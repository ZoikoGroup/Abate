# Stage B Open Governance Sign-Off Records

This ledger records human governance approvals required before **Stage C (Independent Challenge)** sign-off and **Stage D (Pilot Readiness)**. Automated agents MUST NOT fill in approver names, signatures, or approval dates.

---

## 1. Privacy Method Decision (Laplace Noise vs. Deterministic Suppression)
- **Reference**: `ADR-002`, `backend/src/domains/privacy/compile-release.ts`
- **Current Implementation**: Deterministic floor `n >= 10`, Class B min window `28` days, symmetric difference `>= 5`, parent/child residual `>= 5`, zero noise injection.
- **Required Decision**:
  - [ ] Approve deterministic suppression gates (`10 / 28d / 5 / 5`) without noise (prohibiting `"differential privacy"` terminology in all UI/docs/contracts).
  - [ ] Request calibrated Laplace/Gaussian mechanism (`epsilon`, `delta`, bounded sensitivity, deterministic test tolerances).
- **Privacy Owner Name**: `_______________________`
- **Decision & Rationale**: `_______________________`
- **Date**: `YYYY-MM-DD`

---

## 2. Legal Wording & Sector Pack Review
- **Reference**: `ADR-004`, `backend/src/domains/sector-legal/`, `frontend/src/components/`
- **Scope Under Review**:
  1. `"SRA-aligned"` workplace control framing (no `"SRA 2023 Compliance"` certification claims).
  2. UK Legal Pack (`legal-uk-sra`, `sector-legal`) demand windows (`TRIAL_PREP`, `TRIAL`, `CLOSING`, `FILING_DEADLINE`) and forbidden work-product controls.
  3. External customer/regulatory marketing & demo text accuracy.
- **Legal Reviewer Name & Bar/SRA Role**: `_______________________`
- **Status**: `PENDING_REVIEW`
- **Conditions / Redlines**: `_______________________`
- **Date**: `YYYY-MM-DD`

---

## 3. Jurisdiction Retention Durations & Owner Registry
- **Reference**: `backend/src/contracts/retention.ts`, `backend/src/fixtures/seed.ts`
- **Current Synthetic Defaults**: `WORK_FACT` floor `90` days / ceiling `730` days (`SYNTHETIC-FIXTURE`).

| Pack Key | Data Category | Approved Floor (Days) | Approved Ceiling (Days) | Statutory Citation | Accountable Owner | Status |
| :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| `legal-uk-sra` | `WORK_FACT` | `TBD` (synthetic: `90`) | `TBD` (synthetic: `730`) | `TBD (replaces SYNTHETIC-FIXTURE)` | `TBD (Legal & DPO Lead)` | `PENDING` |
| `legal-uk-bar` | `WORK_FACT` | `TBD` | `TBD` | `TBD` | `TBD (Legal & DPO Lead)` | `PENDING` |
| Customer custom packs | `WORK_FACT` | `TBD` | `TBD` | Tenant DPA | Customer Data Controller | `PENDING` |

---

## 4. Phase 8 Measured SLO & Backup/Restore Verification
- **Reference**: `ops/slo-manifest.v1.yaml` (`PENDING_MEASURED_EVIDENCE`), `backend/tools/test-load.ts`, `backend/tools/measure-pg-restore.ts`
- **Evidence Artifacts Required**:
  - `evidence/slo-benchmark-report.json` produced with `executionBacking: "POSTGRESQL_LIVE_HTTP"`
  - `evidence/pg-restore-measurement.json` produced against live PostgreSQL (`pg_dump` + `pg_restore` + tombstone reconciliation, `resurrectedRecords === 0`)
- **Measured Read p95 / Target (`<= 500ms`)**: `TBD`
- **Measured Write p95 / Target (`<= 800ms`)**: `TBD`
- **Measured Release p95 / Target (`<= 1500ms`)**: `TBD`
- **Measured PG Restore + Reconciliation RTO / Target (`<= 4h`)**: `TBD`
- **SRE Owner / Release Owner Sign-Off**: `_______________________` | **Date**: `YYYY-MM-DD`

---

## 5. BE-001–BE-010 Spec Reconciliation & Named Release Authority
- **Reference**: `docs/governance/be-spec-reconciliation.md` (`DRAFT`), `docs/architecture/ADR-001` through `ADR-005` (`DRAFT`)
- **BE-001–010 Spec Holder Name**: `_______________________` | **Date**: `YYYY-MM-DD`
- **Status**: `DRAFT — PENDING HUMAN REVIEW` (confirm acceptance or file redlines against `CR-01`–`CR-05`)
- **Confirmed Named Release Authority (authorized to run `sign-dossier.ts`)**: `_______________________` | **Date Confirmed**: `YYYY-MM-DD`

