================================================================================
ADR-003: DETERMINISTIC COHORT BOUNDARY PROTECTION VS LAPLACE PERTURBATION NOISE
================================================================================

STATUS: ACCEPTED  
OWNER: Privacy & Governance Team  
DATE: 2026-11-12  
FRAMEWORK STANDARD: ZAB-ENG-001 v1.0 & Package B3 (Domain S06 Privacy Compiler)

--------------------------------------------------------------------------------
CONTEXT
--------------------------------------------------------------------------------
Previous early design documentation referred generically to a "Differential Privacy Compiler". In evaluating mathematical privacy mechanisms for workplace psychosocial risk assessment, two competing approaches were considered:
1. Randomized Perturbation (Laplace / Gaussian Noise Addition): Injecting zero-mean random noise scaled to global sensitivity into aggregated metrics.
2. Deterministic Cohort Boundary Protection: Enforcing strict non-reconstruction invariants, including minimum contributor floors (k >= 10), minimum observation durations (>= 28 days), symmetric difference overlap suppression (Delta >= 5), parent/child residual differencing suppression (Delta >= 5), and tenant-wide serialization locks.

In psychosocial risk governance, legal compliance (UK SRA 2023 Workplace Health Regulations, Health and Safety at Work Act 1974, and ISO 45003), and collective labor representation, measurement stability is paramount. Introducing non-deterministic random noise causes significant hazards:
* An organization close to a regulatory hazard boundary could randomly fluctuate between compliant and non-compliant states on successive evaluations of identical underlying data.
* Auditors, safety committees, and regulators cannot reproduce exact calculations during statutory compliance inquiries.
* Legal evidence packages submitted to court or arbitration must possess deterministic SHA-256 integrity proofs.

--------------------------------------------------------------------------------
DECISION
--------------------------------------------------------------------------------
Zoiko Abate officially standardizes on Deterministic Cohort Boundary Protection (Domain S06) for all aggregated workforce metrics (Classes B and C), explicitly rejecting randomized Laplace noise addition in production releases.

The deterministic privacy compiler enforces six non-negotiable architectural invariants:

1. Strict Contributor Floor (k >= 10):
   - Any metric evaluation targeting a cohort with fewer than 10 active contributors is suppressed immediately.
   - Suppressed requests return status "UNAVAILABLE" with generic code "NOT_AVAILABLE". Suppressed contributor counts and boundary thresholds are never disclosed to the caller.

2. Minimum Observation Window (>= 28 Days):
   - Class B metrics require an observation window of at least 4 weeks (28 continuous calendar days) to prevent transient individual attribution.

3. Cross-Query Overlap Differencing Protection (Symmetric Difference >= 5):
   - The disclosure ledger tracks the exact membership set of every released cohort per tenant and metric.
   - If a new query overlaps with a previously released cohort such that the symmetric difference |(A \ B) U (B \ A)| is greater than 0 and less than 5, the release is suppressed ("OVERLAP"). This provably defeats targeted subtraction attacks aiming to isolate individuals across team re-organizations.

4. Parent/Child Residual Differencing Protection (Residual >= 5):
   - If a cohort is a proper subset of a previously released cohort (e.g., Department of 14 vs Team of 10), the residual difference must be at least 5. If the residual is 1 to 4, the release is suppressed ("RESIDUAL").

5. Tenant-Wide Advisory Lock Serialization:
   - Every privacy evaluation acquires a transaction-scoped PostgreSQL advisory lock (`pg_advisory_xact_lock(hashtextextended('disclosure:' || tenant_id, 0))`).
   - This guarantees that concurrent queries cannot race each other to bypass the disclosure ledger before prior disclosures commit.

6. Complete Schema and Role Separation:
   - Intermediate table `metric_snapshot` stores internal contributor counts and code digests for compliance auditing and is granted strictly to `abate_privacy` and `abate_app` (never `abate_worker`).
   - Public release table `released_artifact` contains NO `contributor_count` column, NO employee references, and NO individual timestamps.

--------------------------------------------------------------------------------
CONSEQUENCES AND VERIFICATION
--------------------------------------------------------------------------------
* Compliance: Meets UK GDPR Article 9 minimization, ICO workplace monitoring guidance, and SRA 2023 evidentiary standards.
* Auditability: 100% reproducible metric calculations with fixed SHA-256 evidence package hashes.
* Security: Complete resistance against single-individual re-identification, group subtraction, and racing reconstruction attacks, proven by the standalone Reconstruction Attack Lab (`tools/test-reconstruction.ts`).

