# Sector Rules & Jurisdiction Regulations — Legal & Policy Lead Review Pack

> **Status:** `DRAFT — PENDING HUMAN REVIEW`
> **Purpose:** Engineering has implemented the generalized multi-rule sector engine (`backend/src/domains/sector-work/rule-engine.ts`) and effective-dated jurisdiction overlay contract (`backend/src/domains/lifecycle/sector-pack.ts`). Per `ADR-006` and Completion Plan §8.2–8.3, **engineering does not author approved statutory citations or retention durations.** Non-launched packs stay `PREVIEW` / `PREVIEW_PLACEHOLDER` until a named Legal & Policy Lead signs off below.

---

## 1. Non-Overridable Constitutional Guardrails (Enforced in Code)
- **Privacy Floor:** `n >= 10` distinct contributors, 28-day Class B window, overlap symmetric difference `>= 5`, parent/child residual `>= 5` (`PRIVACY_FLOOR_MINIMUM = 10`). Registration throws `400 VALIDATION` on any attempt to lower it.
- **AI Authority:** Strictly proposal-only (`aiAuthority: "EXPANDED"` rejected at load time).
- **Universal Core Forbidden Fields:** `substantiveWorkProduct`, `individualScore`, `keystrokeLogs` (inherited automatically by every pack; packs may only add fields).
- **Fail-Closed Jurisdiction Overlays:** Any `PREVIEW`, `DRAFT`, `EXPIRED`, or `UNBOUND` overlay sets `supportsComplianceClaim: false`.

---

## 2. Sector Packs & Proposed Cohort Rule Thresholds Awaiting Review

| Sector Pack | Status | Rule IDs Implemented | Proposed Cohort Thresholds (Placeholder until Signed) | Extra Forbidden Fields (Active Minimization) | Statutory Citations & Retention Approval |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **UK Legal (`LEGAL`)** | `LAUNCHED` (overlay `DRAFT`) | `LEGAL_LATE_EVENING_SURGE`, `LEGAL_WEEKEND_REST_DEFICIT`, `LEGAL_SUSTAINED_PEAK_DURATION` | `>= 3` consecutive evenings past 20:00 UTC in trial/closing; `> 1` weekend day / `< 36h` rest; `> 14d` sustained peak | `clientConfidentialNotes`, `privilegedAdvice`, `billingRate`, `feeEarned`, `individualLawyerRanking` | **Reviewer:** `_______________________` · **Date:** `YYYY-MM-DD` |
| **Healthcare (`HEALTHCARE`)** | `PREVIEW` | `HC_INTER_SHIFT_REST`, `HC_SURGE_WINDOW_DURATION`, `HC_ROLLING_WEEKLY_HOURS` | `< 11h` inter-shift turnaround (night-shift safe); `> 14d` surge/winter pressure; `> 48h/wk` rolling cohort avg (17-wk ref) | `patientIdentifier`, `nhsNumber`, `mrn`, `clinicalNotes`, `diagnosisCode`, `medicationRecord`, `individualClinicianRanking` | **Reviewer:** `_______________________` · **Date:** `YYYY-MM-DD` *(Requires clinical/PHI governance sign-off; zero clinical screening in v1.0)* |
| **Software & IT (`SOFTWARE_IT`)** | `PREVIEW` | `SW_LATE_EVENING_CUTOVER`, `SW_ON_CALL_WEEKEND_RECOVERY`, `SW_INCIDENT_INTER_SHIFT_REST` | `>= 3` late evenings in cutover/incident; `> 1` weekend on-call day / `< 36h` rest; `< 11h` post-incident turnaround | `sourceCode`, `commitDiff`, `prCount`, `customerData`, `individualVelocity`, `individualCommitCount`, `individualPerformanceRanking` | **Reviewer:** `_______________________` · **Date:** `YYYY-MM-DD` |
| **Accounting (`ACCOUNTING`)** | `FIXTURE` | `ACC_BUSY_SEASON_LATE_NIGHTS`, `ACC_WEEKEND_REST_DEFICIT`, `ACC_ROLLING_WEEKLY_HOURS` | `>= 3` late evenings in busy season/audit close; `> 1` weekend day / `< 36h` rest; `> 48h/wk` rolling cohort avg | `clientTaxReturns`, `clientWorkpapers`, `auditAdjustments`, `clientFinancials`, `billableUtilizationRanking` | **Product Scope Decision Required (G-06)** before moving from `FIXTURE` to `PREVIEW` or `LAUNCHED`. |
| **Financial Services (`FINANCE`)** | `PREVIEW` | `FIN_MARKET_VOLATILITY_LATE_NIGHTS`, `FIN_MANDATORY_BLOCK_LEAVE_REST`, `FIN_ROLLING_WEEKLY_HOURS`, `FIN_INTER_SESSION_REST` | `>= 3` late evenings past 21:00 UTC in market volatility/quarter close; consecutive weekends without 48h block rest; `> 55h/wk` rolling avg; `< 10h` inter-session gap | `tradeTickets`, `clientPortfolio`, `mnpiContent`, `individualPnL`, `orderBook`, `accountBalance`, `traderRanking` | **Reviewer:** `_______________________` · **Date:** `YYYY-MM-DD` *(Requires FCA/PRA and FINRA conduct risk & MNPI governance sign-off)* |

---

## 3. Graduation Checklist (`PREVIEW` → `LAUNCHED`)
1. Named Product Owner approves sector launch scope (`ADR` / decision register).
2. Named Legal & Policy Lead supplies approved `statutoryReferences`, `consultationGates`, `effectiveFrom`/`effectiveTo`, and statutory retention durations for each `(sectorKey, jurisdictionCode)` overlay.
3. Per-sector decoy minimization lab (`npm --prefix backend run test-sector-rules`) passes with zero persistence/telemetry leaks.
4. Release Dossier scope updated and signed by the named Release Authority.
