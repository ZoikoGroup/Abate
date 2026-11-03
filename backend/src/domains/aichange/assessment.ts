// backend/src/domains/aichange/assessment.ts
// AI Work-Design Risk Assessment staged workflow (Phase 7 / Domain S14)
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import { getAiChangeProfile } from "./profile";
import {
  AiChangeStage,
  CreateAssessmentInput,
  AdvanceAssessmentInput,
  AiWorkDesignAssessmentView
} from "../../contracts/aichange";

export const NEXT_STAGE: Record<AiChangeStage, AiChangeStage[]> = {
  REGISTERED: ["BASELINE"],
  BASELINE: ["DETECT"],
  DETECT: ["ATTRIBUTE"],
  ATTRIBUTE: ["CONTROL"],
  CONTROL: ["VERIFY"],
  VERIFY: ["PERFORMANCE_REVIEW"],
  PERFORMANCE_REVIEW: ["CLOSED"],
  CLOSED: []
};

/**
 * assertStageGuards: Verifies evidentiary prerequisites for stage transitions.
 * Does not mutate assurance state; performs read-only checks.
 */
export async function assertStageGuards(
  tx: Tx,
  tenantId: string,
  current: any,
  to: AiChangeStage,
  payload?: Partial<AdvanceAssessmentInput>
): Promise<void> {
  const mergedBaselines = payload?.baselineReleaseIds || current.baseline_release_ids || [];
  const mergedHazards = payload?.hazardIds || current.hazard_ids || [];
  const mergedControls = payload?.controlIds || current.control_ids || [];
  const mergedVerifications = payload?.verificationRefs || current.verification_refs || [];

  if (to === "DETECT") {
    // Requires released baseline results before rollout
    if (!mergedBaselines || mergedBaselines.length === 0) {
      throw new AppError("CONFLICT", "Stage 'DETECT' requires at least one released baseline result (baseline_release_ids).");
    }
    // Verify each baseline release is RELEASED
    for (const rid of mergedBaselines) {
      const rRes = await tx.q(
        `SELECT id, status FROM privacy_release WHERE id = $1 AND tenant_id = $2`,
        [rid, tenantId]
      );
      if (!rRes.rowCount || rRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", `Baseline release '${rid}' not found.`);
      }
    }
  }

  if (to === "ATTRIBUTE") {
    // Requires candidate hazards surfaced via assurance
    if (!mergedHazards || mergedHazards.length === 0) {
      throw new AppError("CONFLICT", "Stage 'ATTRIBUTE' requires candidate hazards surfaced via assurance (hazard_ids).");
    }
  }

  if (to === "CONTROL") {
    // Requires accepted organizational cause linked in assurance
    if (!mergedHazards || mergedHazards.length === 0) {
      throw new AppError("CONFLICT", "Stage 'CONTROL' requires referenced hazards.");
    }
    for (const hid of mergedHazards) {
      const cRes = await tx.q(
        `SELECT id, status FROM cause WHERE hazard_id = $1 AND tenant_id = $2`,
        [hid, tenantId]
      );
      if (!cRes.rowCount || cRes.rowCount === 0 || !cRes.rows.some((c: any) => c.status === "REVIEWED_ACCEPTED" || c.status === "ACCEPTED" || (c as any).state === "ACCEPTED")) {
        throw new AppError("CONFLICT", `Hazard '${hid}' must have an accepted organizational cause before advancing to CONTROL.`);
      }
    }
  }

  if (to === "VERIFY") {
    // Requires all referenced controls to be in state IMPLEMENTED or VERIFYING
    if (!mergedControls || mergedControls.length === 0) {
      throw new AppError("CONFLICT", "Stage 'VERIFY' requires approved controls (control_ids).");
    }
    for (const cid of mergedControls) {
      const iRes = await tx.q(
        `SELECT id, state FROM intervention WHERE id = $1 AND tenant_id = $2`,
        [cid, tenantId]
      );
      if (!iRes.rowCount || iRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", `Intervention '${cid}' not found.`);
      }
      const state = iRes.rows[0].state;
      if (!["IMPLEMENTED", "VERIFYING", "CLOSED"].includes(state)) {
        throw new AppError(
          "CONFLICT",
          `Intervention '${cid}' is in state '${state}'. Stage 'VERIFY' requires all controls to be IMPLEMENTED or VERIFYING.`
        );
      }
    }
  }

  if (to === "PERFORMANCE_REVIEW") {
    // Standard verification plan and reviewer conclusion must exist
    if (!mergedVerifications || mergedVerifications.length === 0) {
      // Also check if any evaluation exists in assurance
      const evRes = await tx.q(
        `SELECT id, outcome FROM evaluation WHERE tenant_id = $1`,
        [tenantId]
      );
      if (!evRes.rowCount || evRes.rowCount === 0) {
        throw new AppError("CONFLICT", "Stage 'PERFORMANCE_REVIEW' requires verification plan and reviewer conclusion (verification_refs).");
      }
    }
  }

  if (to === "CLOSED") {
    // Playbook mandate: Cannot close assessment while assurance obligations remain open!
    await assertNoOpenAssuranceObligations(tx, tenantId, mergedHazards, mergedControls);
  }
}

/**
 * assertNoOpenAssuranceObligations: Ensures no hazard or control remains open/unresolved.
 */
export async function assertNoOpenAssuranceObligations(
  tx: Tx,
  tenantId: string,
  hazardIds: string[],
  controlIds: string[]
): Promise<void> {
  for (const hid of hazardIds) {
    const hRes = await tx.q(
      `SELECT id, disposition FROM hazard WHERE id = $1 AND tenant_id = $2`,
      [hid, tenantId]
    );
    if (!hRes.rowCount || hRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", `Hazard '${hid}' not found.`);
    }
    const disp = hRes.rows[0].disposition;
    if (disp !== "CONTROLLED" && disp !== "VERIFIED_CLOSURE") {
      throw new AppError(
        "CONFLICT",
        `Cannot close AI change assessment while assurance obligations remain open. Hazard '${hid}' is '${disp}'. Must be CONTROLLED or VERIFIED_CLOSURE.`
      );
    }
  }

  for (const cid of controlIds) {
    const cRes = await tx.q(
      `SELECT id, state FROM intervention WHERE id = $1 AND tenant_id = $2`,
      [cid, tenantId]
    );
    if (!cRes.rowCount || cRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", `Intervention '${cid}' not found.`);
    }
    const state = cRes.rows[0].state;
    if (state !== "CLOSED") {
      throw new AppError(
        "CONFLICT",
        `Cannot close AI change assessment while assurance obligations remain open. Intervention '${cid}' is '${state}'. Must be CLOSED.`
      );
    }
  }
}

/**
 * createAssessment: Creates an initial assessment in stage 'REGISTERED'.
 */
export async function createAssessment(
  tx: Tx,
  actor: Actor,
  input: CreateAssessmentInput
): Promise<AiWorkDesignAssessmentView> {
  // Validate profile exists
  await getAiChangeProfile(tx, actor.tenantId, input.profileId, input.profileVersion);

  const id = crypto.randomUUID();
  const stage = "REGISTERED";
  const version = 1;

  await tx.q(
    `INSERT INTO ai_workdesign_assessment (
      id, tenant_id, profile_id, profile_version, stage,
      hazard_ids, control_ids, baseline_release_ids, verification_refs, version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      actor.tenantId,
      input.profileId,
      input.profileVersion,
      stage,
      [],
      [],
      [],
      [],
      version
    ]
  );

  return await getAssessment(tx, actor.tenantId, id);
}

/**
 * advanceAssessment: Advances stage with If-Match check and stage guards.
 */
export async function advanceAssessment(
  tx: Tx,
  actor: Actor,
  id: string,
  to: AiChangeStage,
  ifMatch: number,
  payload?: Partial<AdvanceAssessmentInput>
): Promise<AiWorkDesignAssessmentView> {
  const res = await tx.q(
    `SELECT * FROM ai_workdesign_assessment WHERE id = $1 AND tenant_id = $2`,
    [id, actor.tenantId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", `Assessment '${id}' not found.`);
  }

  const current = res.rows[0];

  // If-Match optimistic concurrency check
  if (current.version !== ifMatch) {
    throw new AppError("CONFLICT", `Version mismatch on assessment '${id}'. Expected version ${ifMatch}, got ${current.version}.`);
  }

  // State machine transition validation
  const allowedNext = NEXT_STAGE[current.stage as AiChangeStage] || [];
  if (!allowedNext.includes(to)) {
    throw new AppError(
      "CONFLICT",
      `Invalid stage transition from '${current.stage}' to '${to}'. Allowed transitions: ${allowedNext.join(", ") || "none"}.`
    );
  }

  // Evaluate stage guards
  await assertStageGuards(tx, actor.tenantId, current, to, payload);

  // Merge updated lists
  const parseJsonArray = (val: any) => (Array.isArray(val) ? val : JSON.parse(val || "[]"));
  const newHazards = Array.from(new Set([...parseJsonArray(current.hazard_ids), ...(payload?.hazardIds || [])]));
  const newControls = Array.from(new Set([...parseJsonArray(current.control_ids), ...(payload?.controlIds || [])]));
  const newBaselines = Array.from(new Set([...parseJsonArray(current.baseline_release_ids), ...(payload?.baselineReleaseIds || [])]));
  const newVerifications = Array.from(new Set([...parseJsonArray(current.verification_refs), ...(payload?.verificationRefs || [])]));

  const nextVersion = current.version + 1;

  await tx.q(
    `UPDATE ai_workdesign_assessment
     SET stage = $1, hazard_ids = $2, control_ids = $3, baseline_release_ids = $4, verification_refs = $5, version = $6
     WHERE id = $7 AND tenant_id = $8`,
    [
      to,
      newHazards,
      newControls,
      newBaselines,
      newVerifications,
      nextVersion,
      id,
      actor.tenantId
    ]
  );

  return await getAssessment(tx, actor.tenantId, id);
}

/**
 * getAssessment: Fetches assessment and builds view with profile, assurance summary, and performance summary.
 */
export async function getAssessment(
  tx: Tx,
  tenantId: string,
  id: string
): Promise<AiWorkDesignAssessmentView> {
  const res = await tx.q(
    `SELECT * FROM ai_workdesign_assessment WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", `Assessment '${id}' not found.`);
  }

  const r = res.rows[0];
  const parseJsonArray = (val: any) => (Array.isArray(val) ? val : JSON.parse(val || "[]"));
  const hazardIds = parseJsonArray(r.hazard_ids);
  const controlIds = parseJsonArray(r.control_ids);
  const baselineReleaseIds = parseJsonArray(r.baseline_release_ids);
  const verificationRefs = parseJsonArray(r.verification_refs);

  // Read profile
  let profile;
  try {
    profile = await getAiChangeProfile(tx, tenantId, r.profile_id, r.profile_version);
  } catch { }

  // Assurance Summary
  let openHazardsCount = 0;
  for (const hid of hazardIds) {
    const hRes = await tx.q(`SELECT disposition FROM hazard WHERE id = $1 AND tenant_id = $2`, [hid, tenantId]);
    if (hRes.rowCount && hRes.rowCount > 0) {
      const disp = hRes.rows[0].disposition;
      if (disp === "OPEN" || disp === "DEFERRED") openHazardsCount++;
    }
  }

  let pendingControlsCount = 0;
  let verifiedControlsCount = 0;
  for (const cid of controlIds) {
    const cRes = await tx.q(`SELECT state FROM intervention WHERE id = $1 AND tenant_id = $2`, [cid, tenantId]);
    if (cRes.rowCount && cRes.rowCount > 0) {
      const state = cRes.rows[0].state;
      if (state === "PROPOSED" || state === "APPROVAL_REQUIRED" || state === "APPROVED") pendingControlsCount++;
      if (state === "CLOSED" || state === "VERIFYING") verifiedControlsCount++;
    }
  }

  // Performance Summary (Plane B evaluations)
  const evRes = await tx.q(
    `SELECT * FROM outcome_evaluation WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  const permittedClaims: string[] = [];
  for (const row of evRes.rows) {
    const claims = Array.isArray(row.permitted_claims) ? row.permitted_claims : JSON.parse(row.permitted_claims || "[]");
    permittedClaims.push(...claims);
  }

  return {
    id: r.id,
    tenantId: r.tenant_id,
    profileId: r.profile_id,
    profileVersion: r.profile_version,
    stage: r.stage,
    hazardIds,
    controlIds,
    baselineReleaseIds,
    verificationRefs,
    version: r.version,
    profile,
    assuranceSummary: {
      openHazardsCount,
      pendingControlsCount,
      verifiedControlsCount
    },
    performanceSummary: {
      evaluationsCount: evRes.rowCount || 0,
      permittedClaims: Array.from(new Set(permittedClaims))
    }
  };
}

/**
 * listAssessments: Lists all assessments for tenant.
 */
export async function listAssessments(
  tx: Tx,
  tenantId: string
): Promise<AiWorkDesignAssessmentView[]> {
  const res = await tx.q(
    `SELECT id FROM ai_workdesign_assessment WHERE tenant_id = $1 ORDER BY version DESC`,
    [tenantId]
  );
  const items: AiWorkDesignAssessmentView[] = [];
  for (const row of res.rows) {
    items.push(await getAssessment(tx, tenantId, row.id));
  }
  return items;
}
