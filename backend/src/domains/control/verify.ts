// backend/src/domains/control/verify.ts
import { ReleaseView } from "../../contracts/release";
import { VerificationOutcome } from "../../contracts/control";

export interface VerificationPlan {
  direction?: "DECREASE" | "INCREASE";
  criteria?: number; // Target delta percentage (e.g. 5.0% reduction)
  adjacentTolerance?: number; // Max allowable increase in adjacent cohort (e.g. 5.0%)
  seriesBreak?: boolean;
}

export interface SuggestionResult {
  suggestion: VerificationOutcome;
  why: string;
  flag?: boolean;
  transferOfRiskFlag?: boolean;
  transferredRisk?: boolean;
}

function improves(
  direction: "DECREASE" | "INCREASE",
  baseVal: number | null,
  postVal: number | null,
  criteria = 0
): boolean {
  if (baseVal === null || postVal === null) return false;
  if (direction === "DECREASE") {
    return (baseVal - postVal) >= criteria;
  } else {
    return (postVal - baseVal) >= criteria;
  }
}

export interface AdjacentCohortPair {
  baseline?: ReleaseView | { value: number | null; status: string } | null;
  post: ReleaseView | { value: number | null; status: string };
}

function worsens(
  direction: "DECREASE" | "INCREASE",
  adj: AdjacentCohortPair | ReleaseView | { value: number | null; status: string },
  tolerance = 0
): boolean {
  if ("post" in adj) {
    const postVal = adj.post.status === "RELEASED" ? adj.post.value : null;
    const baseVal = adj.baseline && adj.baseline.status === "RELEASED" ? adj.baseline.value : null;
    if (postVal === null) return false;
    if (baseVal !== null) {
      const delta = direction === "DECREASE" ? (postVal - baseVal) : (baseVal - postVal);
      return delta > tolerance;
    }
    return direction === "DECREASE" ? postVal > tolerance : postVal < tolerance;
  } else {
    if (adj.status !== "RELEASED" || adj.value === null) return false;
    return direction === "DECREASE" ? adj.value > tolerance : adj.value < tolerance;
  }
}

/**
 * evaluateSuggestion: Decision aid for named human reviewer (Playbook B4 §6).
 * Suggests an outcome based on baseline vs. post released artifacts and adjacent cohorts.
 * The suggestion NEVER automatically closes or concludes an intervention.
 */
export function evaluateSuggestion(
  plan: VerificationPlan,
  base: ReleaseView | { value: number | null; status: string },
  post: ReleaseView | { value: number | null; status: string },
  adj: Array<AdjacentCohortPair | ReleaseView | { value: number | null; status: string }> = []
): SuggestionResult {
  if (base.status !== "RELEASED" || post.status !== "RELEASED") {
    return { suggestion: "INCONCLUSIVE", why: "MISSING_RELEASE", flag: false, transferOfRiskFlag: false };
  }

  if (plan.seriesBreak) {
    return { suggestion: "INCONCLUSIVE", why: "SERIES_BREAK_NEEDS_REVIEW", flag: false, transferOfRiskFlag: false };
  }

  const direction = plan.direction || "DECREASE";
  const criteria = plan.criteria ?? 0;
  const tolerance = plan.adjacentTolerance ?? 5.0;

  const improved = improves(direction, base.value, post.value, criteria);
  const transferred = adj.some((a) => worsens(direction, a, tolerance));

  if (improved && transferred) {
    return {
      suggestion: "PARTIALLY_EFFECTIVE",
      why: "TRANSFER_OF_RISK",
      flag: true,
      transferOfRiskFlag: true,
      transferredRisk: true
    };
  }

  return {
    suggestion: improved ? "EFFECTIVE" : "NOT_EFFECTIVE",
    why: improved ? "PRIMARY_TARGET_MET" : "TARGET_NOT_MET",
    flag: false,
    transferOfRiskFlag: false
  };
}
