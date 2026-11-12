================================================================================
ADR-007: TWO-PLANE SEPARATION (PLANE A ASSURANCE VS PLANE B PERFORMANCE) (BE-009)
================================================================================

STATUS: ACCEPTED  
OWNER: Safety, Governance & Compliance Architecture Team  
DATE: 2026-11-12  
FRAMEWORK STANDARD: ZAB-ENG-001 v1.0 & Specification ZAB-BE-009 (Domains S13 & S14)

--------------------------------------------------------------------------------
CONTEXT
--------------------------------------------------------------------------------
Organizations balancing workplace safety with commercial productivity face a structural conflict of interest. When productivity analytics, speed metrics, or AI cost-reduction goals share the same operational plane as psychosocial hazard obligations, organizations face systemic pressure to compromise safety standards:
1. Contaminated Governance: Favorable business performance or speed gains used to downgrade, silence, or falsely close active hazard obligations.
2. Uncontrolled Data Cross-Contamination: Exploratory productivity analytics leaking unverified assumptions into statutory legal filings.
3. Premature Sign-Off: AI deployment rollouts being declared "complete" while underlying worker safety or excessive overtime hazards remain unresolved.

--------------------------------------------------------------------------------
DECISION
--------------------------------------------------------------------------------
Zoiko Abate officially standardizes on Specification ZAB-BE-009: Two-Plane Separation (CONF-002). The system strictly bisects the architecture into Plane A (Regulatory Assurance) and Plane B (Work-Design & Performance Outcomes).

1. PLANE A (ASSURANCE & COMPLIANCE):
- Purpose: Statutory psychosocial risk management (UK SRA, ISO 45003, Health & Safety at Work Act).
- Scope: Ingestion ledger, privacy compiler, cohort boundary protection, hazard registers, cause statements, control interventions, independent verifications, and regulatory evidence packages.
- Rule: Immutable, auditable, and uncompromised by business goals.

2. PLANE B (PERFORMANCE & WORK-DESIGN OUTCOMES):
- Purpose: Productivity benchmarking, workflow optimization, turnaround time measurement, and AI change impact assessments.
- Scope: Work-design outcome evaluations, comparison baselines, confounder registries, and AI deployment transition workflows.
- Rule: Gated behind feature flag `outcomes_plane_b` (disabled by default).

3. NON-CONTAMINATION INVARIANTS (CONF-002):
- Invariant 1 (One-Way Dependency): Plane B reads released, verified artifacts from Plane A. Plane A NEVER reads or depends on Plane B.
- Invariant 2 (No Cross-Plane Mutation): Plane B transactions execute with `writePlane: "B"`. Database connection and storage guards strictly forbid any write, update, or disposition change to Plane A tables (`hazard`, `intervention`, `work_fact_revision`, `privacy_release`) from a Plane B execution context. Any attempt throws `FORBIDDEN`.
- Invariant 3 (Prohibited Claims Engine): Outcome evaluations in Plane B undergo strict semantic inspection. Claims asserting hazard mitigation, legal compliance, or hazard closure (e.g. "proved the intervention controlled the hazard") fail closed with `VALIDATION`.
- Invariant 4 (Endpoint Isolation): Privacy releases created in Plane B are invisible to Plane A reader endpoints. Querying a Plane B release through the Plane A endpoint returns `NOT_FOUND`.
- Invariant 5 (Governance Gate on AI Change Closure): In AI change assessments (from `REGISTERED` through `PERFORMANCE_REVIEW`), advancing the assessment to `CLOSED` is strictly prohibited if any associated hazard remains in an `OPEN` disposition or any intervention remains unclosed. Attempts to close while hazards remain open fail closed with `CONFLICT`.

--------------------------------------------------------------------------------
CONSEQUENCES
--------------------------------------------------------------------------------
- Guarantees regulatory integrity: safety obligations can never be subordinated to operational speed or commercial efficiency.
- Legal teams and external auditors receive an unpolluted Plane A evidence dossier.
- Commercial teams can explore work-design and AI productivity optimizations in Plane B without jeopardizing safety compliance.

