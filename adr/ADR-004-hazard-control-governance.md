================================================================================
ADR-004: PSYCHOSOCIAL HAZARD AND CONTROL GOVERNANCE (BE-007)
================================================================================

STATUS: ACCEPTED  
OWNER: Safety & Governance Architecture Team  
DATE: 2026-11-12  
FRAMEWORK STANDARD: ZAB-ENG-001 v1.0 & Specification ZAB-BE-007 (Domains S05 & S07)

--------------------------------------------------------------------------------
CONTEXT
--------------------------------------------------------------------------------
Psychosocial risk management (UK SRA 2023, ISO 45003, and UK Health and Safety at Work Act 1974) mandates that organizational work-design risks (e.g. chronic after-hours boundary intrusion, unrealistic demands, lack of control) follow a formal, accountable governance cycle.

Earlier drafts allowed ad-hoc state changes and did not strictly tie approvals to specific intervention definitions, creating three compliance failure modes:
1. Approval Bypassing: Controls being deployed directly without required risk and policy approvals.
2. Silent Scope Creep: An approved intervention being materially rewritten (e.g. changing scope or weakening objectives) while falsely retaining its prior approval status.
3. Transfer of Risk: An intervention improving working conditions for one group by shifting excessive work or late-night filing demands onto an adjacent cohort.

--------------------------------------------------------------------------------
DECISION
--------------------------------------------------------------------------------
Zoiko Abate officially standardizes on Specification ZAB-BE-007: Hazard & Control Governance. The system enforces strict state machine rules, version-bound approvals, automated transfer-of-risk detection, and sealed evidence packaging.

1. BE-007 STATE MACHINE MAPPING TABLE:

| Hazard Disposition | Control Lifecycle State | Allowed Transitions | Authorized Role | Required Guard / Condition |
|--------------------|-------------------------|---------------------|-----------------|----------------------------|
| OPEN | DRAFT | -> PROPOSED | RISK_OWNER | Valid hazard link and accepted cause statement. |
| OPEN | PROPOSED | -> APPROVAL_REQUIRED | RISK_OWNER | Policy resolution check completed. Direct jump to IMPLEMENTING is forbidden. |
| OPEN | APPROVAL_REQUIRED | -> APPROVED | APPROVER | Approval record binds current version and material hash. |
| OPEN | APPROVED | -> IMPLEMENTING | CONTROL_OWNER | Approval still active; delegating authority still valid. |
| OPEN | IMPLEMENTING | -> IMPLEMENTED | CONTROL_OWNER | Implementation evidence recorded (policy ref, config change, training log). |
| OPEN | IMPLEMENTED | -> VERIFYING | RISK_OWNER | Post-intervention observation window active (>= 28 days). |
| CONTROLLED | VERIFYING | -> CLOSED | REVIEWER | Named human reviewer records explicit conclusion based on verification release. Zero auto-closure. |
| REOPENED | CLOSED | -> REOPENED | RISK_OWNER | Recurrence evidence recorded from newer released metrics. |
| DEFERRED / ACCEPTED | DRAFT / PROPOSED | -> CANCELLED / SUPERSEDED | RISK_OWNER | Documented residual risk acceptance with named governance signoff. |

2. VERSION-BOUND APPROVALS ("v4 CANNOT APPROVE v5" RULE):
- An approval binds both `approved_version` (integer) and `approved_material_hash` (SHA-256).
- Material fields: `hazardId`, `causeId`, `scope`, `objective`, `ownerPrincipalId`, `dueDate`, `verificationPlan`.
- If any material field is modified:
  * The intervention version increments (e.g., v1 -> v2).
  * The state resets immediately to `APPROVAL_REQUIRED`.
  * The prior approval is invalidated.
- Non-material cosmetic edits (e.g., formatting notes, non-decision comments) do not alter the material hash and preserve approval validity.

3. TRANSFER-OF-RISK DETECTION:
- During the `VERIFYING` phase, the evaluation compares baseline vs post-intervention metrics for the primary cohort AND checks adjacent cohorts.
- If the primary cohort improves (e.g. boundary intrusion drops by >= 10%), but an adjacent cohort worsens by more than the tolerance threshold (e.g. increases by > 5%):
  * The system flags `TRANSFER_OF_RISK`.
  * The decision aid suggests `PARTIALLY_EFFECTIVE` (not `EFFECTIVE`).
- Decision aid only: The system NEVER automatically closes or concludes an intervention. A named human reviewer must review the evidence and record the final conclusion.

4. IMMUTABLE EVIDENCE PACKAGE EXPORT:
- A completed hazard cycle produces a sealed Evidence Package containing:
  * Originating hazard and accepted organizational cause.
  * Approved intervention with version and material hash.
  * Signed approval metadata and authority reference.
  * Baseline, post-intervention, and adjacent cohort released artifacts.
  * Verification outcome and named reviewer conclusion.
- A cryptographic SHA-256 manifest hash is generated over canonical sorted JSON. Tampering with any field invalidates the manifest hash.

5. TWO-PLANE NON-CONTAMINATION (CONF-002):
- Plane B (work-design outcomes: efficiency, billable hours, AI rework rate) can NEVER mutate, close, or downgrade a Plane A (hazard assurance) obligation.
- Even if work output improves significantly, a hazard remains open until safety verification proves the risk is controlled.

--------------------------------------------------------------------------------
CONSEQUENCES AND VERIFICATION
--------------------------------------------------------------------------------
- Full compliance with UK SRA 2023 workplace health rules and ISO 45003.
- All state machine transitions, version-bound approval invalidations, transfer-of-risk alerts, and evidence package sealing are verified by the dedicated test suite (`tools/test-phase4-control.ts`).

