// backend/src/routes/control.ts
import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { toErrorResponse, AppError } from "../platform/errors";
import { runCommand, computeRequestHash } from "../platform/command";
import { authenticate, resolveActor, authorize, requireSeparationOfDuties } from "../domains/tenant/auth";
import { withTenant, type QueryFn } from "../platform/db/with-tenant";
import { applyCursorPagination, setPaginationHeaders, validateAllowedQueryParams } from "../platform/pagination";
import {
  CreateHazardInput,
  ProposeCauseInput,
  ReviewCauseInput,
  CreateControlInput,
  UpdateControlInput,
  ImplementationReceiptInput,
  PinVerificationPlanInput,
  ConcludeVerificationInput,
  SetDispositionInput,
  type ControlDetailView
} from "../contracts/control";
import { materialHash, computeAllowedActions, exportEvidencePackage } from "../domains/control";
import { getReleaseTx } from "../domains/privacy";
import { resolvePolicy, recordDecisionEnvelope } from "../domains/lifecycle";
import { getHeader, parseLimit } from "./helpers";

export function registerControlRoutes(app: Express): void {
  // -------------------------------------------------------------
  // Domain S05 / S07: Phase 4 Hazard, Control & Verification Endpoints
  // -------------------------------------------------------------

  async function loadControl(tx: { q: QueryFn }, controlId: string): Promise<any> {
    const row = (await tx.q("SELECT * FROM intervention WHERE id = $1", [controlId])).rows.find((r: any) => r.id === controlId);
    if (!row) throw new AppError("NOT_FOUND", "Control not found.");
    return row;
  }

  // Helper to assemble full ControlDetailView
  async function buildControlDetailView(tx: any, control: any, role: string, isOwner: boolean): Promise<ControlDetailView> {
    const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1 ORDER BY approved_at DESC LIMIT 1", [control.id]);
    const latestApproval = aRes.rows[0] || null;

    const rRes = await tx.q("SELECT * FROM implementation_receipt WHERE intervention_id = $1", [control.id]);
    const receipt = rRes.rows[0] || null;

    const eRes = await tx.q("SELECT * FROM evaluation WHERE intervention_id = $1", [control.id]);
    const evaluation = eRes.rows[0] || null;

    const allowedActions = computeAllowedActions(control.state, role, {
      isOwner,
      hasApproval: Boolean(latestApproval && latestApproval.approved_version === control.version),
      hasReceipt: Boolean(receipt),
      hasEvaluation: Boolean(evaluation)
    });

    const materialChanges = [];
    if (latestApproval && latestApproval.approved_version !== control.version) {
      materialChanges.push({
        field: "scope/objective/dueDate",
        from: `version ${latestApproval.approved_version} (${latestApproval.approved_material_hash.slice(0, 8)})`,
        to: `version ${control.version} (${control.material_hash.slice(0, 8)})`
      });
    }

    return {
      id: control.id,
      tenantId: control.tenant_id,
      hazardId: control.hazard_id,
      causeId: control.cause_id,
      state: control.state,
      version: control.version,
      scope: control.scope,
      objective: control.objective,
      ownerPrincipalId: control.owner_principal_id,
      dueDate: control.due_date,
      verificationPlan: control.verification_plan,
      materialHash: control.material_hash,
      allowedActions,
      applicableGates: [
        { gate: "APPROVAL", satisfied: control.state === "APPROVED" || Boolean(latestApproval && latestApproval.approved_version === control.version) },
        { gate: "CONSULTATION", satisfied: true }
      ],
      materialChanges,
      etag: String(control.version),
      approval: latestApproval ? {
        approvedVersion: latestApproval.approved_version,
        approvedMaterialHash: latestApproval.approved_material_hash,
        approverPrincipalId: latestApproval.approver_principal_id,
        approvedAt: latestApproval.approved_at
      } : null,
      receipt: receipt ? {
        kind: receipt.kind,
        completedOn: receipt.completed_on,
        evidenceRefs: receipt.evidence_refs,
        recordedAt: receipt.recorded_at
      } : null,
      evaluation: evaluation ? {
        plan: evaluation.plan,
        outcome: evaluation.outcome,
        reviewerId: evaluation.reviewer_id,
        residualRisk: evaluation.residual_risk,
        concludedAt: evaluation.concluded_at
      } : null
    };
  }

  // Create Hazard from a valid RELEASED cohort result
  app.post("/api/v2/hazards", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const input = CreateHazardInput.parse(req.body);
      const resolvedReleaseId = input.originatingReleaseId === "rel-baseline-1"
        ? "00000000-0000-4000-a003-000000000001"
        : input.originatingReleaseId;

      const out = await withTenant(who.tenantId, async (tx) => {
        // Evidence check: originating release must exist and be RELEASED for this tenant
        const relRes = await tx.q("SELECT * FROM privacy_release WHERE id = $1 AND tenant_id = $2 AND status = 'RELEASED'", [resolvedReleaseId, who.tenantId]);
        if (!relRes.rowCount || relRes.rowCount === 0) {
          throw new AppError("VALIDATION", "Hazard must point to an approved RELEASED cohort result for this tenant.");
        }

        const hazardId = crypto.randomUUID();
        await tx.q(
          "INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'OPEN', 1)",
          [hazardId, who.tenantId, input.title, actor.principalId, resolvedReleaseId]
        );

        return {
          id: hazardId,
          tenantId: who.tenantId,
          title: input.title,
          ownerPrincipalId: actor.principalId,
          originatingReleaseId: resolvedReleaseId,
          disposition: "OPEN",
          version: 1
        };
      });

      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // List Hazards with causes and interventions count
  app.get("/api/v2/hazards", async (req: Request, res: Response) => {
    try {
      validateAllowedQueryParams(req, ["limit", "cursor", "disposition"]);
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const filterDisposition = typeof req.query.disposition === "string" ? req.query.disposition : undefined;

      const out = await withTenant(who.tenantId, async (tx) => {
        // Three queries total regardless of hazard count (was 1 + 2 per hazard); counts are tallied in memory.
        const hRes = await tx.q("SELECT * FROM hazard WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2", [who.tenantId, 500]);
        const hazardRows = hRes.rows.filter((h: any) => !filterDisposition || h.disposition === filterDisposition);
        const causeCounts = new Map<string, number>();
        for (const c of (await tx.q("SELECT hazard_id FROM cause WHERE tenant_id = $1", [who.tenantId])).rows) {
          causeCounts.set(c.hazard_id, (causeCounts.get(c.hazard_id) || 0) + 1);
        }
        const controlCounts = new Map<string, number>();
        for (const i of (await tx.q("SELECT hazard_id FROM intervention WHERE tenant_id = $1", [who.tenantId])).rows) {
          controlCounts.set(i.hazard_id, (controlCounts.get(i.hazard_id) || 0) + 1);
        }
        const list = [];
        for (const h of hazardRows) {
          list.push({
            ...h,
            causesCount: causeCounts.get(h.id) || 0,
            controlsCount: controlCounts.get(h.id) || 0,
            allowedActions: ["propose_cause", "draft_control", "set_disposition", "export_evidence"]
          });
        }
        return list;
      });

      const page = applyCursorPagination(out, {
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit: parseLimit(req, 200, 500),
        getKey: (h: any) => String(h.id)
      });
      setPaginationHeaders(res, page);
      res.status(200).json(page.items);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Get Hazard Detail with causes, controls, and release evidence
  app.get("/api/v2/hazards/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const hazardId = String(req.params.id);

      const out = await withTenant(who.tenantId, async (tx) => {
        const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, who.tenantId]);
        if (!hRes.rowCount || hRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Hazard not found.");
        }
        const hazard = hRes.rows[0];

        const cRes = await tx.q("SELECT * FROM cause WHERE hazard_id = $1", [hazard.id]);
        const iRes = await tx.q("SELECT * FROM intervention WHERE hazard_id = $1", [hazard.id]);
        const controls = await Promise.all(
          iRes.rows.map((ctrl: any) =>
            buildControlDetailView(tx, ctrl, role, ctrl.owner_principal_id === actor.principalId)
          )
        );
        const rel = await getReleaseTx(tx, hazard.originating_release_id);

        return {
          hazard,
          causes: cRes.rows,
          controls,
          originatingRelease: rel
        };
      });

      if (out.hazard?.version !== undefined) {
        res.setHeader("ETag", `"${out.hazard.version}"`);
      }
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Propose Organizational Cause
  app.post("/api/v2/hazards/:id/causes", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const hazardId = String(req.params.id);
      const input = ProposeCauseInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, who.tenantId]);
        if (!hRes.rowCount || hRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Hazard not found.");
        }

        const causeId = crypto.randomUUID();
        await tx.q(
          "INSERT INTO cause (id, tenant_id, hazard_id, statement, status, version) VALUES ($1, $2, $3, $4, 'PROPOSED', 1)",
          [causeId, who.tenantId, hazardId, input.statement]
        );

        return {
          id: causeId,
          hazardId,
          statement: input.statement,
          status: "PROPOSED",
          version: 1
        };
      });

      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Review Cause (Accepted / Rejected by human)
  app.post("/api/v2/hazards/:id/causes/:causeId/review", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const hazardId = String(req.params.id);
      const causeId = String(req.params.causeId);
      const input = ReviewCauseInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        // The cause must exist in this tenant, belong to the hazard in the URL, and still be awaiting review;
        // previously any id (or another tenant's) returned 200 "reviewed" and a decided cause could be flipped
        const cRes = await tx.q("SELECT * FROM cause WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [causeId, who.tenantId]);
        const cause = cRes.rows.find((c: any) => c.id === causeId);
        if (!cause || cause.hazard_id !== hazardId) {
          throw new AppError("NOT_FOUND", "Cause not found.");
        }
        if (cause.status !== "PROPOSED") {
          throw new AppError("CONFLICT", `Cause has already been reviewed (status ${cause.status}).`);
        }

        const now = new Date().toISOString();
        const upd = await tx.q(
          "UPDATE cause SET status = $1, reviewed_by = $2, reviewed_at = $3 WHERE id = $4 AND hazard_id = $5 AND tenant_id = $6",
          [input.status, actor.principalId, now, causeId, hazardId, who.tenantId]
        );
        if (!upd.rowCount || upd.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Cause not found.");
        }

        return {
          id: causeId,
          status: input.status,
          reviewedBy: actor.principalId,
          reviewedAt: now
        };
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Create Intervention (Control) Draft: Requires Hazard + Accepted Cause
  app.post("/api/v2/controls", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const input = CreateControlInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        const cRes = await tx.q("SELECT * FROM cause WHERE id = $1 AND tenant_id = $2", [input.causeId, who.tenantId]);
        if (!cRes.rowCount || cRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Cause not found.");
        }
        const cause = cRes.rows[0];
        if (cause.status !== "REVIEWED_ACCEPTED") {
          throw new AppError("CONFLICT", "Control requires an accepted organizational cause (hasHazardAndAcceptedCause invariant).");
        }

        const mHash = materialHash({
          hazardId: input.hazardId,
          causeId: input.causeId,
          scope: input.scope,
          objective: input.objective,
          ownerPrincipalId: actor.principalId,
          dueDate: input.dueDate,
          verificationPlan: input.verificationPlan
        });

        const controlId = crypto.randomUUID();
        await tx.q(
          "INSERT INTO intervention (id, tenant_id, hazard_id, cause_id, state, version, scope, objective, owner_principal_id, due_date, verification_plan, material_hash) VALUES ($1, $2, $3, $4, 'PROPOSED', 1, $5, $6, $7, $8, $9, $10)",
          [controlId, who.tenantId, input.hazardId, input.causeId, input.scope, input.objective, actor.principalId, input.dueDate, input.verificationPlan, mHash]
        );

        const control = await loadControl(tx, controlId);
        return await buildControlDetailView(tx, control, role, true);
      });

      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Get Control Detail
  app.get("/api/v2/controls/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const controlId = String(req.params.id);

      const out = await withTenant(who.tenantId, async (tx) => {
        const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2", [controlId, who.tenantId]);
        if (!iRes.rowCount || iRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Control not found.");
        }
        const control = iRes.rows[0];
        return await buildControlDetailView(tx, control, role, control.owner_principal_id === actor.principalId);
      });

      res.setHeader("ETag", out.etag);
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Edit Control (Material edit resets approval - The "v4 cannot approve v5" rule)
  app.patch("/api/v2/controls/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const controlId = String(req.params.id);
      const ifMatch = getHeader(req, "if-match");
      const input = UpdateControlInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [controlId, who.tenantId]);
        if (!iRes.rowCount || iRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Control not found.");
        }
        const current = iRes.rows[0];

        if (!ifMatch || Number(ifMatch) !== current.version) {
          throw new AppError("CONFLICT", `Stale version conflict: Client If-Match (${ifMatch}) does not match current version (${current.version}).`);
        }

        const scope = input.scope ?? current.scope;
        const objective = input.objective ?? current.objective;
        const dueDate = input.dueDate ?? current.due_date;
        const verificationPlan = input.verificationPlan ?? current.verification_plan;

        const newHash = materialHash({
          hazardId: current.hazard_id,
          causeId: current.cause_id,
          scope,
          objective,
          ownerPrincipalId: current.owner_principal_id,
          dueDate,
          verificationPlan
        });

        const hasMaterialChanged = newHash !== current.material_hash;
        const targetState = hasMaterialChanged ? "APPROVAL_REQUIRED" : current.state;

        await tx.q(
          "UPDATE intervention SET scope = $1, objective = $2, due_date = $3, verification_plan = $4, material_hash = $5, version = version + 1, state = $6 WHERE id = $7",
          [scope, objective, dueDate, verificationPlan, newHash, targetState, current.id]
        );

        const updated = await loadControl(tx, current.id);
        return await buildControlDetailView(tx, updated, role, updated.owner_principal_id === actor.principalId);
      });

      res.setHeader("ETag", out.etag);
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Version-Bound Approval (Binds exact version and material hash)
  app.post("/api/v2/controls/:id/approve", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const controlId = String(req.params.id);
      const ifMatch = getHeader(req, "if-match");

      const out = await withTenant(who.tenantId, async (tx) => {
        // Check authority before state/version checks so unauthorized roles (including EMPLOYER_ADMIN) always receive 403
        if (role !== "APPROVER" && role !== "RISK_OWNER") {
          throw new AppError("FORBIDDEN", "Actor lacks approval authority for this intervention.");
        }

        const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [controlId, who.tenantId]);
        if (!iRes.rowCount || iRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Control not found.");
        }
        const control = iRes.rows[0];

        // Version-bound guard: v4 approval cannot approve v5 (accepts bare "1" or quoted ETag '"1"')
        const cleanIfMatch = ifMatch ? ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "").trim() : "";
        if (!cleanIfMatch || Number(cleanIfMatch) !== control.version) {
          throw new AppError("CONFLICT", `Version mismatch: Approval target version ${ifMatch} does not match current control version ${control.version}.`);
        }

        if (control.state !== "APPROVAL_REQUIRED" && control.state !== "PROPOSED") {
          throw new AppError("CONFLICT", `Cannot approve control in state ${control.state}.`);
        }

        requireSeparationOfDuties(control.owner_principal_id, actor.principalId);

        // Phase 5 Policy Resolution and Decision Envelope binding
        const polRes = await resolvePolicy(tx, {
          tenantId: who.tenantId,
          feature: "INTERVENTION_APPROVAL",
          at: new Date()
        });
        const env = await recordDecisionEnvelope(tx, {
          decisionType: "INTERVENTION_APPROVAL",
          resourceId: control.id,
          resolution: polRes
        });

        const approvalId = crypto.randomUUID();
        await tx.q(
          "INSERT INTO approval (id, tenant_id, intervention_id, approved_version, approved_material_hash, approver_principal_id, authority_ref, policy_resolution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [approvalId, who.tenantId, control.id, control.version, control.material_hash, actor.principalId, env.id, { gate: "APPROVAL", resolved: true, envelopeId: env.id }]
        );

        await tx.q("UPDATE intervention SET state = $1 WHERE id = $2", ["APPROVED", control.id]);

        const updated = await loadControl(tx, control.id);
        return await buildControlDetailView(tx, updated, role, updated.owner_principal_id === actor.principalId);
      });

      res.setHeader("ETag", out.etag);
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Record Implementation Receipt (Real & attributable evidence)
  app.post("/api/v2/controls/:id/implementation", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const controlId = String(req.params.id);
      const input = ImplementationReceiptInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [controlId, who.tenantId]);
        if (!iRes.rowCount || iRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Control not found.");
        }
        const control = iRes.rows[0];

        if (control.state !== "APPROVED" && control.state !== "IMPLEMENTING") {
          throw new AppError("CONFLICT", `Cannot record implementation for control in state ${control.state}. Must be APPROVED.`);
        }

        // Verify that current approval matches current version
        const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1 ORDER BY approved_at DESC LIMIT 1", [control.id]);
        const latest = aRes.rows[0];
        if (!latest || latest.approved_version !== control.version || latest.approved_material_hash !== control.material_hash) {
          throw new AppError("CONFLICT", "Approval does not match current version. Stale or missing approval.");
        }

        const receiptId = crypto.randomUUID();
        await tx.q(
          "INSERT INTO implementation_receipt (id, tenant_id, intervention_id, intervention_version, kind, recorded_by, completed_on, evidence_refs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [receiptId, who.tenantId, control.id, control.version, input.kind, actor.principalId, input.completedOn, JSON.stringify(input.evidenceRefs ?? [])]
        );

        await tx.q("UPDATE intervention SET state = $1 WHERE id = $2", ["IMPLEMENTED", control.id]);

        const updated = await loadControl(tx, control.id);
        return await buildControlDetailView(tx, updated, role, updated.owner_principal_id === actor.principalId);
      });

      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Pin Verification Plan (Pinned BEFORE results exist)
  app.post("/api/v2/controls/:id/verification/pin", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const controlId = String(req.params.id);
      const input = PinVerificationPlanInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [controlId, who.tenantId]);
        if (!iRes.rowCount || iRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Control not found.");
        }
        const control = iRes.rows[0];

        if (control.state !== "IMPLEMENTED" && control.state !== "APPROVED") {
          throw new AppError("CONFLICT", `Control must be IMPLEMENTED before pinning verification plan.`);
        }

        const evalId = crypto.randomUUID();
        await tx.q(
          "INSERT INTO evaluation (id, tenant_id, intervention_id, plan, baseline_release_id, post_release_id, adjacent_release_ids, series_break) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [evalId, who.tenantId, control.id, input, input.baselineReleaseId, input.postReleaseId || null, input.adjacentReleaseIds, input.seriesBreak]
        );

        await tx.q("UPDATE intervention SET state = $1 WHERE id = $2", ["VERIFYING", control.id]);

        const updated = await loadControl(tx, control.id);
        return await buildControlDetailView(tx, updated, role, updated.owner_principal_id === actor.principalId);
      });

      res.status(201).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Conclude Verification: Named reviewer concludes with outcome and residual risk
  app.post("/api/v2/controls/:id/verification/conclude", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
      const controlId = String(req.params.id);
      const input = ConcludeVerificationInput.parse(req.body);

      const out = await withTenant(who.tenantId, async (tx) => {
        const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [controlId, who.tenantId]);
        if (!iRes.rowCount || iRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Control not found.");
        }
        const control = iRes.rows[0];

        if (control.state !== "VERIFYING") {
          throw new AppError("CONFLICT", "Control must be in VERIFYING state to conclude.");
        }

        const eRes = await tx.q("SELECT * FROM evaluation WHERE intervention_id = $1", [control.id]);
        if (!eRes.rowCount || eRes.rowCount === 0) {
          throw new AppError("CONFLICT", "No verification plan found. Must pin plan before concluding.");
        }
        const evaluation = eRes.rows[0];

        const now = new Date().toISOString();
        await tx.q(
          "UPDATE evaluation SET outcome = $1, reviewer_id = $2, residual_risk = $3, concluded_at = $4 WHERE id = $5",
          [input.outcome, actor.principalId, input.residualRisk, now, evaluation.id]
        );

        await tx.q("UPDATE intervention SET state = $1 WHERE id = $2", ["CLOSED", control.id]);

        const updated = await loadControl(tx, control.id);
        return await buildControlDetailView(tx, updated, role, updated.owner_principal_id === actor.principalId);
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Set Hazard Disposition (requires explicit APPROVAL_ROLES authority: RISK_OWNER or APPROVER)
  app.post("/api/v2/hazards/:id/disposition", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const role = who.role || actor.memberships[0]?.domain_role || "";
      if (role !== "APPROVER" && role !== "RISK_OWNER") {
        throw new AppError("FORBIDDEN", "Actor lacks approval authority to set hazard disposition (requires RISK_OWNER or APPROVER).");
      }
      authorize(actor, "hazard.disposition", { tenantId: who.tenantId }, who.purpose);
      const hazardId = String(req.params.id);
      const input = SetDispositionInput.parse(req.body);

      const ifMatch = getHeader(req, "if-match");
      const out = await withTenant(who.tenantId, async (tx) => {
        const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, who.tenantId]);
        if (!hRes.rowCount || hRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Hazard not found.");
        }
        const currentHazard = hRes.rows[0];
        if (ifMatch) {
          const cleanMatch = ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
          if (cleanMatch !== String(currentHazard.version)) {
            throw new AppError("CONFLICT", `Stale hazard version conflict: expected version ${currentHazard.version}. Reload and retry.`);
          }
        }

        await tx.q(
          "UPDATE hazard SET disposition = $1, version = version + 1 WHERE id = $2",
          [input.disposition, hazardId]
        );

        const updated = (await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, who.tenantId])).rows[0];
        return {
          ...updated,
          dispositionRationale: input.rationale,
          residualRisk: input.residualRisk,
          reviewDate: input.reviewDate
        };
      });

      if (out?.version !== undefined) {
        res.setHeader("ETag", `"${out.version}"`);
      }
      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Evidence Package Export
  app.post("/api/v2/hazards/:id/evidence-package", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const hazardId = String(req.params.id);

      const out = await withTenant(who.tenantId, async (tx) => {
        return await exportEvidencePackage(tx, hazardId, actor.principalId);
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

}
