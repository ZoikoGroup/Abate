// backend/src/domains/performance/evaluations.ts
// Outcome evaluation recording (Plane B: Work-Design Outcomes)
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import { getRelease } from "../privacy/get-release";
import { requireFeatureFlag } from "./flags";
import {
  EvaluateOutcomeInput,
  OutcomeEvaluationView
} from "../../contracts/outcomes";

const PROHIBITED_CLAIM_PATTERNS = [
  /proved the intervention worked/i,
  /controlled the hazard/i,
  /hazard is controlled/i,
  /safe to close/i,
  /eliminates risk/i,
  /individual productivity/i
];

/**
 * assertPermittedClaims: Ensures permitted claims do not attempt to assert risk control or individual attribution.
 */
export function assertPermittedClaims(claims: string[]): void {
  for (const c of claims) {
    for (const pat of PROHIBITED_CLAIM_PATTERNS) {
      if (pat.test(c)) {
        throw new AppError(
          "VALIDATION",
          `Permitted claim '${c}' violates constitutional separation. Performance outcomes can NEVER claim to prove intervention effectiveness or close a hazard.`
        );
      }
    }
  }
}

/**
 * evaluateOutcome: Records a Plane-B outcome evaluation linked to a Privacy Release.
 * Commands in this namespace execute with write_plane = 'B'.
 */
export async function evaluateOutcome(
  tx: Tx,
  actor: Actor,
  input: EvaluateOutcomeInput
): Promise<OutcomeEvaluationView> {
  // 1. Require feature flag
  await requireFeatureFlag(tx, actor.tenantId, "outcomes_plane_b");

  // 2. Validate outcome definition exists and is APPROVED
  const dRes = await tx.q(
    `SELECT * FROM outcome_definition WHERE outcome_id = $1 AND version = $2`,
    [input.outcomeId, input.outcomeVersion]
  );
  if (!dRes.rowCount || dRes.rowCount === 0) {
    throw new AppError("NOT_FOUND", `Outcome definition '${input.outcomeId}' v${input.outcomeVersion} not found.`);
  }
  const def = dRes.rows[0];
  if (def.status !== "APPROVED") {
    throw new AppError("CONFLICT", `Outcome definition '${input.outcomeId}' is in state '${def.status}'. Must be APPROVED.`);
  }

  // 3. Validate permitted claims
  assertPermittedClaims(input.permittedClaims);

  // 4. Verify release exists (single read path)
  // Value comes from a Privacy Release; plane is 'B'
  const release = await getRelease(actor, input.releaseId);
  if (release.status !== "RELEASED") {
    throw new AppError("CONFLICT", `Release '${input.releaseId}' is '${release.status}'. Evaluation requires an approved RELEASED artifact.`);
  }

  // 5. Optional read-only reference to intervention (if supplied)
  if (input.interventionId) {
    const iRes = await tx.q(
      `SELECT id, state FROM intervention WHERE id = $1 AND tenant_id = $2`,
      [input.interventionId, actor.tenantId]
    );
    if (!iRes.rowCount || iRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", `Intervention '${input.interventionId}' not found.`);
    }
  }

  // 6. Insert outcome_evaluation (Plane B)
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await tx.q(
    `INSERT INTO outcome_evaluation (
      id, tenant_id, outcome_id, outcome_version, intervention_id,
      comparison_basis, confounders, series_break, outcome_confidence,
      permitted_claims, evidence_refs, release_id, plane, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      actor.tenantId,
      input.outcomeId,
      input.outcomeVersion,
      input.interventionId || null,
      input.comparisonBasis,
      input.confounders,
      input.seriesBreak,
      input.outcomeConfidence,
      input.permittedClaims,
      input.evidenceRefs,
      input.releaseId,
      "B", // Database constraint CHECK (plane = 'B')
      now
    ]
  );

  return {
    id,
    tenantId: actor.tenantId,
    outcomeId: input.outcomeId,
    outcomeVersion: input.outcomeVersion,
    interventionId: input.interventionId,
    comparisonBasis: input.comparisonBasis,
    confounders: input.confounders,
    seriesBreak: input.seriesBreak,
    outcomeConfidence: input.outcomeConfidence,
    permittedClaims: input.permittedClaims,
    evidenceRefs: input.evidenceRefs,
    releaseId: input.releaseId,
    plane: "B",
    createdAt: now
  };
}

/**
 * getOutcomeEvaluation: Fetches an evaluation by id.
 */
export async function getOutcomeEvaluation(
  tx: Tx,
  tenantId: string,
  id: string
): Promise<OutcomeEvaluationView> {
  const res = await tx.q(
    `SELECT * FROM outcome_evaluation WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", `Outcome evaluation '${id}' not found.`);
  }
  const r = res.rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    outcomeId: r.outcome_id,
    outcomeVersion: r.outcome_version,
    interventionId: r.intervention_id || undefined,
    comparisonBasis: r.comparison_basis,
    confounders: r.confounders,
    seriesBreak: Boolean(r.series_break),
    outcomeConfidence: r.outcome_confidence,
    permittedClaims: r.permitted_claims,
    evidenceRefs: r.evidence_refs,
    releaseId: r.release_id,
    plane: "B",
    createdAt: r.created_at
  };
}

/**
 * listOutcomeEvaluations: Lists outcome evaluations for tenant.
 */
export async function listOutcomeEvaluations(
  tx: Tx,
  tenantId: string
): Promise<OutcomeEvaluationView[]> {
  const res = await tx.q(
    `SELECT * FROM outcome_evaluation WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    tenantId: r.tenant_id,
    outcomeId: r.outcome_id,
    outcomeVersion: r.outcome_version,
    interventionId: r.intervention_id || undefined,
    comparisonBasis: r.comparison_basis,
    confounders: r.confounders,
    seriesBreak: Boolean(r.series_break),
    outcomeConfidence: r.outcome_confidence,
    permittedClaims: r.permitted_claims,
    evidenceRefs: r.evidence_refs,
    releaseId: r.release_id,
    plane: "B",
    createdAt: r.created_at
  }));
}
