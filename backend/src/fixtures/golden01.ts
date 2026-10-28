// backend/src/fixtures/golden01.ts
/**
 * Canonical test fixture: ABATE-GOLDEN-01
 * Used across Phases 0–4 to prove tenant isolation, boundary invariants,
 * deterministic measurement, and Privacy Release controls.
 */
export const GOLDEN_01 = {
  tenantA: {
    id: "00000000-0000-4000-a000-00000000000a",
    name: "Apex Legal Partners (Tenant A)",
    region: "eu-west-2",
    cohortSize: 16,
    baselineWeeks: 8,
    comparisonWeeks: 8,
    defaultPurpose: "WORKPLACE_RISK_ASSESSMENT"
  },
  tenantB: {
    id: "00000000-0000-4000-b000-00000000000b",
    name: "Beacon Chambers (Tenant B)",
    region: "eu-west-2",
    cohortSize: 12,
    defaultPurpose: "WORKPLACE_RISK_ASSESSMENT"
  },
  // Documented variants from Playbook Section 05 & Phase 0/1 specifications
  variants: {
    nineContributors: {
      description: "Reduce valid contributors to 9 to prove automatic Privacy Release suppression (n < 10)",
      targetCount: 9,
      expectedOutcome: "SUPPRESSED"
    },
    duplicates: {
      description: "Same record delivered twice to test deduplication idempotency",
      behavior: "EXACT_REPLAY_NO_DUPLICATION"
    },
    correction: {
      description: "Higher revision of an earlier record supersedes previous state",
      behavior: "APPEND_REVISION_NOT_OVERWRITE"
    },
    sourceOutage: {
      description: "No response for a collection window yields stale state, never zero work",
      behavior: "QUALITY_STATE_STALE"
    },
    changedApproverRole: {
      description: "Approver loses authority between request and approval",
      behavior: "APPROVAL_REJECTED"
    }
  }
};

