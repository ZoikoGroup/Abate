# ADR-001: Two-Plane Separation & Physical Non-Surveillance Perimeter

- **Status**: Accepted (Synthetic Sandbox Verified; Legal/Pilot Review Open)
- **Date**: 2026-11-16
- **Scope**: Phases 0, 2, 7 (`backend/src/contracts/`, `backend/src/domains/ingest/`, `backend/src/domains/performance/`)

## Context
Zoiko Abate measures aggregate psychosocial workload hazards across cohorts while prohibiting individual employee monitoring, surveillance telemetry, or productivity-ranking abuse.

## Decision
1. **Strict Zod `.strict()` Perimeter**: All ingestion schemas (`ZoikoTimeIntervalV1`, `CalendarCadenceEventV1`) and command payloads (`PublishPackInput`, `CreateOrganizationInput`, etc.) enforce `.strict()` parsing. Unknown or surveillance fields (e.g., `screenshotUrl`, `keystrokeTracker`, `sickReason`, `eventTitle`, `attendees`, `billingRate`) are rejected at validation time with zero persistence trace across staging tables, audit logs, outbox events, or application logs.
2. **Plane A vs. Plane B Isolation**:
   - **Plane A** governs psychosocial safety & work-design outcomes (`COMPLIANCE_EVIDENCE` in `OutcomeClassEnum`, `hazard`, `intervention`, `evaluation`).
   - **Plane B** (`PERFORMANCE_OUTCOME` in `OutcomeClassEnum`) holds commercial/performance metrics and is blocked at both TypeScript domain layer and PostgreSQL triggers (`assert_plane_a`, `assert_outcome_class_immutable` in `0070_outcomes_ai_change.sql`) from modifying `hazard.disposition`, `intervention.state`, or `evaluation.outcome`.
3. **Immutable Audit & Safe Logging**: Application errors log opaque fingerprints instead of user-supplied or secret values (`test-fast.ts` Safe Logs check).

## Consequences
- Zero unmodeled fields can pass API boundaries via `.passthrough()`.
- Decoy surveillance payloads leave zero trace in `work_fact_revision`, `audit_event`, `outbox_event`, `ingest_receipt`, or `idempotency_record` (`npm --prefix backend run test-minimization`).
