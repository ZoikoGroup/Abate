// backend/src/domains/lifecycle/entitlement.ts
import { Entitlements, PolicyResolution, CommercialDecision } from "../../contracts/governance";

/**
 * Essential lifecycle features that can NEVER be blocked by commercial downgrades or suspension.
 * PDF Page 4: "Downgrades cannot bypass rights, retention or evidence handling.
 * Lab: suspend an optional paid feature -> deletion/rights/export-of-own-evidence still work."
 */
const INVIOLABLE_LIFECYCLE_FEATURES = new Set([
  "lifecycle.erase",
  "lifecycle.holds",
  "lifecycle.retention",
  "evidence.export",
  "evidence.verify"
]);

/**
 * featureAllowed: Enforces the Commercial Entitlement AND Policy Permission Model (Playbook B5 §4).
 * Both gates are required:
 *   can(feature) = entitlements.has(feature) && policy.permits(feature)
 * 
 * Invariants:
 * 1. Upgrades cannot buy lower privacy thresholds (privacyProfile and metricDefinitions have no entitlement input).
 * 2. Downgrades cannot bypass rights, retention or evidence handling.
 * 3. Commercial lifecycle is separate from tenant processing state and jurisdiction activation.
 */
export function featureAllowed(
  feature: string,
  ent: Entitlements,
  policy: PolicyResolution
): CommercialDecision {
  // Inviolable features are always commercially entitled
  const isLifecycleEssential = INVIOLABLE_LIFECYCLE_FEATURES.has(feature);

  // 1. Check Commercial Entitlement
  const hasEntitlement = isLifecycleEssential || (
    ent.features.includes(feature) && !ent.suspendedFeatures.includes(feature)
  );

  if (!hasEntitlement) {
    return { allowed: false, reason: "NOT_ENTITLED" };
  }

  // 2. Check Legal / Policy Permission
  const isRestrictedByPolicy = policy.restricted.includes(feature) || policy.ambiguous;
  if (isRestrictedByPolicy) {
    return { allowed: false, reason: "POLICY_RESTRICTED" };
  }

  return { allowed: true };
}

/**
 * Default synthetic entitlements for tenants
 */
export function getDefaultEntitlements(tenantId: string): Entitlements {
  return {
    tier: "ENTERPRISE",
    features: [
      "org.create",
      "ingest.batch",
      "analytics.query",
      "hazard.manage",
      "control.approve",
      "control.verify",
      "evidence.export",
      "evidence.verify",
      "lifecycle.retention",
      "lifecycle.holds",
      "lifecycle.erase"
    ],
    suspendedFeatures: []
  };
}
