// backend/src/domains/control/material.ts
import crypto from "node:crypto";

export interface InterventionDraft {
  hazardId: string;
  causeId: string;
  scope: string;
  objective: string;
  ownerPrincipalId: string;
  dueDate: string;
  verificationPlan: any;
}

/**
 * stableStringify: Deterministic JSON serialization sorting object keys recursively
 */
export function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * materialHash: Computes SHA-256 over only the fields that matter to the decision:
 * scope, owner, objective, due date, verification plan, and linked hazard/cause.
 * Cosmetic edits (e.g. typos in non-decision notes) do not reset approval;
 * material edits do (The "v4 cannot approve v5" rule).
 */
export function materialHash(i: InterventionDraft): string {
  const norm = {
    hazardId: i.hazardId,
    causeId: i.causeId,
    scope: i.scope,
    objective: i.objective,
    ownerPrincipalId: i.ownerPrincipalId,
    dueDate: i.dueDate,
    verificationPlan: i.verificationPlan
  };
  return crypto.createHash("sha256").update(stableStringify(norm)).digest("hex");
}

