# ADR-002: Deterministic Cohort Privacy Compiler & Suppression Gates

- **Status**: **DRAFT — Pending Human Review** (agent-authored from codebase inspection; awaiting BE spec holder & Privacy Owner acceptance)
- **Date**: 2026-11-16
- **Scope**: Phase 3 (`backend/src/domains/privacy/compile-release.ts`)

## Context
Cohort analytics (`BOUNDARY_INTRUSION_SHARE` and related indicators) must prevent individual re-identification via small cohorts, overlapping queries, parent/child differencing, or concurrent racing requests, without making unverified cryptographic claims.

## Decision
1. **Deterministic Suppression Parameters (`DEFAULT_PRIVACY_PROFILE`)**:
   - Minimum active contributors per cohort: `contributorFloor = 10` (`n < 10` returns `status: "UNAVAILABLE"`, `code: "NOT_AVAILABLE"`, with zero `releaseId`).
   - Minimum Class B measurement window: `minWindowDays = 28`.
   - Minimum cross-request symmetric difference: `overlapMin = 5`.
   - Minimum parent/child subset residual: `residualMin = 5`.
2. **Serialized Disclosure Ledger**: `compileRelease` acquires `pg_advisory_xact_lock(hashtextextended('disclosure:' || tenantId, 0))` per transaction so overlapping queries cannot race past differencing checks.
3. **Single Read Path Schema Minimization**: `released_artifact` omits `contributor_count`, `cohort_members`, and `subject_pseudonym` columns completely.
4. **No Laplace / Differential Privacy Overclaim**: Current builds perform deterministic suppression rather than calibrated random noise injection (ε-DP). References to `"differential privacy"` in UI/docs were removed in Stage A.

## Open Decision Required (Stage B Gate)
The named **Privacy Owner** must formally sign `docs/governance/open-signoffs.md` choosing either:
- **Option A**: Retain deterministic suppression thresholds (`10 / 28d / 5 / 5`) explicitly documented as disclosure-suppression gates (no ε-DP claim), **or**
- **Option B**: Specify exact ε/δ/sensitivity bounds and deterministic test seeding to introduce Laplace/Gaussian noise into `compileRelease`.
