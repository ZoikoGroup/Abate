// backend/src/index.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { loadConfig } from "./platform/config";
import { toErrorResponse, AppError } from "./platform/errors";
import { openApiSpec, CreateOrganizationBody, TokenRequestBody, ZoikoTimeBatchV1, SemanticQueryV1 } from "./contracts";
import { authenticate, resolveActor, createDevToken } from "./domains/tenant/auth";
import { createOrganization, getOrganization, listOrganizations, getTenant } from "./domains/tenant/commands";
import { ingestBatch, listConnections, getConnection, setConnectionState, listReceipts, listWorkFacts } from "./domains/ingest";
import { compileRelease, getRelease } from "./domains/privacy";
import {
  ExplainReleaseInput,
  DraftCauseInput,
  DraftControlInput,
  KillSwitchInput,
  ActionProposalInput
} from "./contracts";
import {
  runAiUseCase,
  acceptAiRun,
  discardAiRun,
  getKillSwitches,
  setKillSwitch
} from "./domains/ai";
import {
  mintGrant,
  verifyGrant,
  createActionAttempt,
  dispatchAttempt
} from "./domains/actions";
import {
  canTenantFeature,
  getDefaultEntitlements,
  resolvePolicy,
  recordDecisionEnvelope,
  getDecisionEnvelope,
  issuePackage,
  getEvidencePackage,
  eraseSubject,
  onCorrection,
  acknowledgeCorrection
} from "./domains/lifecycle";
import {
  CreateHazardInput,
  ProposeCauseInput,
  ReviewCauseInput,
  CreateControlInput,
  UpdateControlInput,
  ApproveControlInput,
  ImplementationReceiptInput,
  PinVerificationPlanInput,
  ConcludeVerificationInput,
  SetDispositionInput,
  ControlDetailView
} from "./contracts/control";
import {
  materialHash,
  computeAllowedActions,
  evaluateSuggestion,
  exportEvidencePackage
} from "./domains/control";
import {
  SetRetentionClassInput,
  PlaceLegalHoldInput,
  ReleaseLegalHoldInput,
  RunRetentionInput
} from "./contracts/retention";
import {
  getJurisdictionCoverage,
  listJurisdictionPackVersions,
  getRetentionState,
  previewRetention,
  setRetentionClass,
  placeLegalHold,
  releaseLegalHold,
  runRetention
} from "./domains/lifecycle";
import { telemetry, telemetryMiddleware } from "./platform/telemetry";
import { buildSloReport } from "./platform/slo";
import { SupportTokenRequestBody } from "./contracts/support";
import {
  createSupportToken,
  authenticateSupport,
  generateDiagnosticReceipt,
  verifyDiagnosticReceipt
} from "./domains/support";
import { withTenant } from "./platform/db/with-tenant";
import { drainOnce } from "./worker/outbox-publisher";
import { memDb } from "./platform/db/with-tenant";
import { seedTwoTenants } from "./fixtures/seed";

const cfg = loadConfig();
const app = express();

// B8: per-request id, latency and status for SLOs (route templates only, no content)
app.use(telemetryMiddleware);

app.use(cors({
  origin: cfg.clientUrl,
  credentials: true
}));

app.use(express.json());

// Initialize fixtures for development environment
if (cfg.appEnv === "local" || cfg.appEnv === "test") {
  seedTwoTenants({ clock: new Date(cfg.fixedClock) }).catch(err => {
    console.warn("[Init] Local fixture seeding notice:", err.message);
  });
}

function getHeader(req: Request, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (!val) return null;
  return Array.isArray(val) ? val[0] ?? null : val;
}

// -------------------------------------------------------------
// Health and Metadata Endpoints
// -------------------------------------------------------------

app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    app: "Zoiko Abate",
    version: "1.0.0",
    environment: cfg.appEnv,
    timestamp: new Date().toISOString(),
    constitutionalBoundaries: {
      individualScoring: "PROHIBITED",
      surveillanceMining: "PROHIBITED",
      clinicalDependency: "PROHIBITED",
      privacyGate: "CLASS_B_C_MIN_10_CONTRIBUTORS",
      planeSeparation: "PLANE_B_CANNOT_MUTATE_PLANE_A",
      supportModel: "ZERO_IMPERSONATION_SIGNED_DIAGNOSTICS"
    }
  });
});

app.get("/api/info", (_req: Request, res: Response) => {
  res.status(200).json({
    app: "Zoiko Abate",
    version: "1.0.0",
    description: "Organizational work-design and psychosocial-risk infrastructure.",
    architecture: {
      framework: "TypeScript / Node.js Modular Monolith",
      databaseRoles: "Separate abate_migrator and restricted abate_app (NOSUPERUSER, NOBYPASSRLS)",
      isolation: "PostgreSQL Forced Row-Level Security with transaction-local context",
      reliability: "Single command pipeline with Idempotency, Append-Only Audit, and Outbox"
    },
    domains: {
      S01: "Tenant, access, organization (Active)",
      S02_S03: "Ingestion / work-state ledger",
      S04_S06: "Measurement / Privacy Release",
      S05_S07: "Hazards / interventions",
      S08_S09: "Bounded AI / action execution",
      S10: "Governance and evidence",
      S11_S12: "Commercial / lifecycle (jurisdiction packs, retention, legal hold)"
    }
  });
});

// Canonical Contract Registry (OpenAPI 3.1)
app.get("/api/v2/contracts/openapi.json", (_req: Request, res: Response) => {
  res.status(200).json(openApiSpec);
});

// -------------------------------------------------------------
// Authentication Endpoints (/api/v2/auth)
// -------------------------------------------------------------

app.post("/api/v2/auth/token", (req: Request, res: Response) => {
  try {
    const body = TokenRequestBody.parse(req.body);
    const token = createDevToken(body);
    res.status(200).json({
      token,
      tokenType: "Bearer",
      expiresIn: "8h",
      tenantId: body.tenantId,
      subject: body.subject,
      role: body.role
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S01: Tenancy and Organization Endpoints (/api/v2)
// -------------------------------------------------------------

app.get("/api/v2/tenants/current", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const tenant = await getTenant({ who, actor });
    res.status(200).json(tenant);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Create organization (Thin route handler: authenticate -> resolve -> parse Zod -> check idempotency-key -> command)
app.post("/api/v2/organizations", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    
    // Strict schema validation: rejects unknown or prohibited fields immediately
    const body = CreateOrganizationBody.parse(req.body);

    const idempotencyKey = getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key");
    if (!idempotencyKey) {
      throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
    }

    const result = await createOrganization({
      who,
      actor,
      body,
      idempotencyKey
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/organizations", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const orgs = await listOrganizations({ who, actor });
    res.status(200).json(orgs);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/organizations/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const orgId = String(req.params.id);

    const org = await getOrganization({ who, actor, orgId });
    res.status(200).json(org);
  } catch (err) {
    // Safe error response: foreign tenant and non-existent yield identical 404 NOT_FOUND
    toErrorResponse(err, res);
  }
});

// Audit events query for caller's tenant
app.get("/api/v2/audit-events", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());

    // Filter audit trail strictly by authenticated tenant
    const events = memDb.auditEvents.filter(e => e.tenant_id === who.tenantId);
    res.status(200).json(events);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Worker Outbox Drainage Endpoint
app.post("/api/v2/outbox/drain", async (_req: Request, res: Response) => {
  try {
    const report = await drainOnce();
    res.status(200).json({
      status: "ok",
      report,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S02 / S03: Phase 2 Ingestion & Work-State Ledger Endpoints
// -------------------------------------------------------------

// Ingest ZoikoTime batch (Strict allowlist, natural batchId idempotency, returns safe counts)
app.post("/api/v2/connectors/zoikotime/batches", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    
    // Strict schema parse: unknown or prohibited top-level fields rejected immediately
    const batch = ZoikoTimeBatchV1.parse(req.body);

    const idempotencyKey = getHeader(req, "idempotency-key") || batch.batchId;
    const out = await ingestBatch({
      who,
      actor,
      batch,
      idempotencyKey
    });

    res.status(out.status).json(out.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// List Connections for tenant (includes freshness & health derivation)
app.get("/api/v2/connections", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conns = await listConnections({ who, actor });
    res.status(200).json(conns);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/connections/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await getConnection({ who, actor, connectionId: String(req.params.id) });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Connection state transitions (Pause / Resume / Revoke)
app.post("/api/v2/connections/:id/pause", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await setConnectionState({
      who,
      actor,
      connectionId: String(req.params.id),
      newState: "PAUSED"
    });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/connections/:id/resume", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await setConnectionState({
      who,
      actor,
      connectionId: String(req.params.id),
      newState: "ACTIVE"
    });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/connections/:id/revoke", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await setConnectionState({
      who,
      actor,
      connectionId: String(req.params.id),
      newState: "REVOKED"
    });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Ingest Receipts (Traceable receipts with counts only, NEVER rejected payloads)
app.get("/api/v2/receipts", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const receipts = await listReceipts({ who, actor });
    res.status(200).json(receipts);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Work Fact Revisions (Pseudonymized ledger facts)
app.get("/api/v2/work-facts", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const facts = await listWorkFacts({ who, actor });
    res.status(200).json(facts);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S04 / S06: Phase 3 Measurement & Privacy Release Endpoints
// -------------------------------------------------------------

// Metric definitions list
app.get("/api/v2/metrics/definitions", async (_req: Request, res: Response) => {
  try {
    let rawDefs = Array.from(memDb.metricDefinitions.values());
    if (rawDefs.length === 0) {
      rawDefs = [{
        id: "BOUNDARY_INTRUSION_SHARE",
        metric_id: "BOUNDARY_INTRUSION_SHARE",
        name: "Boundary Intrusion Share",
        hazard_domain: "Working Time Quality & Rest Deficits",
        version: 1,
        formula_id: "boundaryIntrusionShare",
        contributor_floor: 10,
        min_window_days: 28,
        approved_at: new Date().toISOString()
      }];
    }
    const defs = rawDefs.map(d => ({
      id: d.id || d.metric_id || "BOUNDARY_INTRUSION_SHARE",
      version: d.version || 1,
      name: d.name || "Boundary Intrusion Share",
      hazard_domain: d.hazard_domain || "Working Time Quality & Rest Deficits",
      formula_id: d.formula_id || "boundaryIntrusionShare",
      contributor_floor: d.contributor_floor || 10,
      min_window_days: d.min_window_days || 28,
      created_at: d.approved_at || new Date().toISOString()
    }));
    res.status(200).json(defs);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Request cohort result for a semantic query (Compiler Gate: n>=10, window>=28d, overlap/residual differencing)
app.post("/api/v2/releases/query", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    // Extract query and optional custom cohort members (used by Reconstruction Lab)
    const rawQuery = (req.body && req.body.query) ? req.body.query : req.body;
    const customCohortMembers = (req.body && Array.isArray(req.body.customCohortMembers))
      ? req.body.customCohortMembers
      : undefined;

    // Validate using strict SemanticQueryV1 schema
    const normDate = (d: any, fallback: string) => {
      const val = d || fallback;
      return typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val) ? `${val}T00:00:00.000Z` : val;
    };
    const query = SemanticQueryV1.parse({
      metricId: rawQuery.metricId || "BOUNDARY_INTRUSION_SHARE",
      metricVersion: Number(rawQuery.metricVersion) || 1,
      cohortRef: rawQuery.cohortRef || "org:00000000-0000-4000-a001-000000000001",
      periodStart: normDate(rawQuery.periodStart, "2026-03-02T00:00:00.000Z"),
      periodEnd: normDate(rawQuery.periodEnd, "2026-03-30T00:00:00.000Z"),
      releaseClass: rawQuery.releaseClass || "CLASS_B"
    });

    const out = await compileRelease(who.tenantId, query, customCohortMembers);

    // Playbook mandate: Identical body shape for every suppression reason (FLOOR, OVERLAP, RESIDUAL, QUALITY)
    if (out.status === "RELEASED" && out.releaseId) {
      const release = await getRelease(actor, out.releaseId);
      res.status(200).json(release);
    } else {
      res.status(200).json({ status: "UNAVAILABLE", code: "NOT_AVAILABLE" });
    }
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Fetch a released value (The single read path: employer channels read released_artifact only)
app.get("/api/v2/releases/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const release = await getRelease(actor, String(req.params.id));
    res.status(200).json(release);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// CSV Export of released value
app.get("/api/v2/releases/:id/export.csv", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const release = await getRelease(actor, String(req.params.id));
    if (release.status !== "RELEASED") {
      throw new AppError("NOT_FOUND", "No approved release found to export.");
    }

    const headers = "Release ID,Metric,Version,Value,Unit,Period Start,Period End,Quality,Interpretation\n";
    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    const row = `${release.releaseId},${escapeCsv(release.metricName)},${release.version},${release.value},${release.unit},${release.periodStart},${release.periodEnd},${release.quality},${escapeCsv(release.interpretation || "")}\n`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="release-${release.releaseId.slice(0, 8)}.csv"`);
    res.status(200).send(headers + row);
  } catch (err) {
    toErrorResponse(err, res);
  }
});



// Trigger metric recomputation after correction (worker job)
app.post("/api/v2/metrics/:id/recalculate", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());

    const jobId = crypto.randomUUID();
    let recalculatedCount = 0;
    // In production, enqueued to worker; here marks active releases as SUPERSEDED
    for (const r of memDb.privacyReleases.values()) {
      if (r.tenant_id === who.tenantId && r.metric_id === req.params.id && r.status === "RELEASED") {
        r.status = "SUPERSEDED";
        recalculatedCount++;
      }
    }

    res.status(200).json({
      jobId,
      status: "QUEUED",
      count: recalculatedCount,
      message: "Recalculation job queued; affected snapshots and releases marked superseded."
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S05 / S07: Phase 4 Hazard, Control & Verification Endpoints
// -------------------------------------------------------------

// Helper to assemble full ControlDetailView
async function buildControlDetailView(tx: any, control: any, role: string, isOwner: boolean): Promise<ControlDetailView> {
  const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1", [control.id]);
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const input = CreateHazardInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      // Evidence check: originating release must exist and be RELEASED for this tenant
      const relRes = await tx.q("SELECT * FROM privacy_release WHERE id = $1 AND tenant_id = $2 AND status = 'RELEASED'", [input.originatingReleaseId, who.tenantId]);
      if (!relRes.rowCount || relRes.rowCount === 0) {
        throw new AppError("VALIDATION", "Hazard must point to an approved RELEASED cohort result for this tenant.");
      }

      const hazardId = crypto.randomUUID();
      await tx.q(
        "INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'OPEN', 1)",
        [hazardId, who.tenantId, input.title, actor.principalId, input.originatingReleaseId]
      );

      return {
        id: hazardId,
        tenantId: who.tenantId,
        title: input.title,
        ownerPrincipalId: actor.principalId,
        originatingReleaseId: input.originatingReleaseId,
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
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());

    const out = await withTenant(who.tenantId, async (tx) => {
      const hRes = await tx.q("SELECT * FROM hazard WHERE tenant_id = $1", [who.tenantId]);
      const list = [];
      for (const h of hRes.rows) {
        const cRes = await tx.q("SELECT count(*) as count FROM cause WHERE hazard_id = $1", [h.id]);
        const iRes = await tx.q("SELECT count(*) as count FROM intervention WHERE hazard_id = $1", [h.id]);
        list.push({
          ...h,
          causesCount: Number(cRes.rows[0]?.count || 0),
          controlsCount: Number(iRes.rows[0]?.count || 0),
          allowedActions: ["propose_cause", "draft_control", "set_disposition", "export_evidence"]
        });
      }
      return list;
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Get Hazard Detail with causes, controls, and release evidence
app.get("/api/v2/hazards/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const hazardId = String(req.params.id);

    const out = await withTenant(who.tenantId, async (tx) => {
      const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, who.tenantId]);
      if (!hRes.rowCount || hRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Hazard not found.");
      }
      const hazard = hRes.rows[0];

      const cRes = await tx.q("SELECT * FROM cause WHERE hazard_id = $1", [hazard.id]);
      const iRes = await tx.q("SELECT * FROM intervention WHERE hazard_id = $1", [hazard.id]);
      const rel = await getRelease(actor, hazard.originating_release_id);

      return {
        hazard,
        causes: cRes.rows,
        controls: iRes.rows,
        originatingRelease: rel
      };
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Propose Organizational Cause
app.post("/api/v2/hazards/:id/causes", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const causeId = String(req.params.causeId);
    const input = ReviewCauseInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const now = new Date().toISOString();
      await tx.q(
        "UPDATE cause SET status = $1, reviewed_by = $2, reviewed_at = $3 WHERE id = $4",
        [input.status, actor.principalId, now, causeId]
      );

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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
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

      const control = memDb.interventions.get(controlId);
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
    const controlId = String(req.params.id);
    const ifMatch = getHeader(req, "if-match");
    const input = UpdateControlInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2", [controlId, who.tenantId]);
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

      const updated = memDb.interventions.get(current.id);
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
    const controlId = String(req.params.id);
    const ifMatch = getHeader(req, "if-match");

    const out = await withTenant(who.tenantId, async (tx) => {
      const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2", [controlId, who.tenantId]);
      if (!iRes.rowCount || iRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Control not found.");
      }
      const control = iRes.rows[0];

      // Version-bound guard: v4 approval cannot approve v5
      if (!ifMatch || Number(ifMatch) !== control.version) {
        throw new AppError("CONFLICT", `Version mismatch: Approval target version ${ifMatch} does not match current control version ${control.version}.`);
      }

      if (control.state !== "APPROVAL_REQUIRED" && control.state !== "PROPOSED") {
        throw new AppError("CONFLICT", `Cannot approve control in state ${control.state}.`);
      }

      // Check authority: Approver or Risk Owner
      if (role !== "APPROVER" && role !== "RISK_OWNER") {
        throw new AppError("FORBIDDEN", "Actor lacks approval authority for this intervention.");
      }

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

      await tx.q("UPDATE intervention SET state = 'APPROVED' WHERE id = $1", ["APPROVED", control.id]);

      const updated = memDb.interventions.get(control.id);
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
    const controlId = String(req.params.id);
    const input = ImplementationReceiptInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2", [controlId, who.tenantId]);
      if (!iRes.rowCount || iRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Control not found.");
      }
      const control = iRes.rows[0];

      if (control.state !== "APPROVED" && control.state !== "IMPLEMENTING") {
        throw new AppError("CONFLICT", `Cannot record implementation for control in state ${control.state}. Must be APPROVED.`);
      }

      // Verify that current approval matches current version
      const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1", [control.id]);
      const latest = aRes.rows[0];
      if (!latest || latest.approved_version !== control.version || latest.approved_material_hash !== control.material_hash) {
        throw new AppError("CONFLICT", "Approval does not match current version. Stale or missing approval.");
      }

      const receiptId = crypto.randomUUID();
      await tx.q(
        "INSERT INTO implementation_receipt (id, tenant_id, intervention_id, intervention_version, kind, recorded_by, completed_on, evidence_refs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [receiptId, who.tenantId, control.id, control.version, input.kind, actor.principalId, input.completedOn, input.evidenceRefs]
      );

      await tx.q("UPDATE intervention SET state = 'IMPLEMENTED' WHERE id = $1", ["IMPLEMENTED", control.id]);

      const updated = memDb.interventions.get(control.id);
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
    const controlId = String(req.params.id);
    const input = PinVerificationPlanInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2", [controlId, who.tenantId]);
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

      await tx.q("UPDATE intervention SET state = 'VERIFYING' WHERE id = $1", ["VERIFYING", control.id]);

      const updated = memDb.interventions.get(control.id);
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const role = who.role || actor.memberships[0]?.domain_role || "RISK_OWNER";
    const controlId = String(req.params.id);
    const input = ConcludeVerificationInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const iRes = await tx.q("SELECT * FROM intervention WHERE id = $1 AND tenant_id = $2", [controlId, who.tenantId]);
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

      await tx.q("UPDATE intervention SET state = 'CLOSED' WHERE id = $1", ["CLOSED", control.id]);

      const updated = memDb.interventions.get(control.id);
      return await buildControlDetailView(tx, updated, role, updated.owner_principal_id === actor.principalId);
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Set Hazard Disposition
app.post("/api/v2/hazards/:id/disposition", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());
    const hazardId = String(req.params.id);
    const input = SetDispositionInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, who.tenantId]);
      if (!hRes.rowCount || hRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Hazard not found.");
      }

      await tx.q(
        "UPDATE hazard SET disposition = $1 WHERE id = $2",
        [input.disposition, hazardId]
      );

      const updated = memDb.hazards.get(hazardId);
      return {
        ...updated,
        dispositionRationale: input.rationale,
        residualRisk: input.residualRisk,
        reviewDate: input.reviewDate
      };
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Evidence Package Export
app.post("/api/v2/hazards/:id/evidence-package", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const hazardId = String(req.params.id);

    const out = await withTenant(who.tenantId, async (tx) => {
      return await exportEvidencePackage(tx, hazardId, actor.principalId);
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Phase 5 (B5): Jurisdiction Packs, Retention & Legal Hold
// -------------------------------------------------------------

function parseAt(raw: unknown): Date | undefined {
  if (raw === undefined) return undefined;
  const at = new Date(String(raw));
  if (Number.isNaN(at.getTime())) {
    throw new AppError("VALIDATION", "Query parameter 'at' must be an ISO 8601 timestamp.");
  }
  return at;
}

// Jurisdiction pack in effect for the tenant at a point in time (defaults to now)
app.get("/api/v2/jurisdiction/coverage", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const at = parseAt(req.query.at);
    const coverage = await getJurisdictionCoverage({ who, actor, ...(at ? { at } : {}) });
    res.status(200).json(coverage);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// All published versions of the tenant's pack (effective-dated history)
app.get("/api/v2/jurisdiction/pack-versions", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    res.status(200).json(await listJurisdictionPackVersions({ who, actor }));
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Retention classes, legal holds, run receipts and tombstone digests
app.get("/api/v2/retention", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    res.status(200).json(await getRetentionState({ who, actor }));
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Dry run: what a retention run would do now, without writing
app.get("/api/v2/retention/preview", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const { dataCategory } = RunRetentionInput.parse({ dataCategory: req.query.dataCategory ?? "WORK_FACT" });
    res.status(200).json(await previewRetention({ who, actor, dataCategory }));
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/retention/classes", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const result = await setRetentionClass({
      who,
      actor,
      input: SetRetentionClassInput.parse(req.body),
      idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/retention/runs", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const { dataCategory } = RunRetentionInput.parse(req.body);
    const result = await runRetention({
      who,
      actor,
      dataCategory,
      idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/legal-holds", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const result = await placeLegalHold({
      who,
      actor,
      input: PlaceLegalHoldInput.parse(req.body),
      idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/legal-holds/:id/release", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const result = await releaseLegalHold({
      who,
      actor,
      holdId: String(req.params.id),
      input: ReleaseLegalHoldInput.parse(req.body),
      idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// B8: SLOs & Zero-Impersonation Support
// -------------------------------------------------------------

// Dev-only issuance; production support credentials come from the identity provider
app.post("/api/v2/auth/support-token", (req: Request, res: Response) => {
  try {
    if (cfg.appEnv !== "local" && cfg.appEnv !== "test") {
      throw new AppError("NOT_FOUND", "Not found.");
    }
    const { operator } = SupportTokenRequestBody.parse(req.body);
    res.status(200).json({ token: createSupportToken({ operator }), tokenType: "Bearer", expiresIn: "1h", operator });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/ops/slo", (req: Request, res: Response) => {
  try {
    authenticateSupport(getHeader(req, "authorization"));
    res.status(200).json(buildSloReport(telemetry.snapshot()));
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Look up what happened to a request a tenant reported (by the requestId in their error)
app.get("/api/v2/ops/requests/:requestId", (req: Request, res: Response) => {
  try {
    authenticateSupport(getHeader(req, "authorization"));
    const record = telemetry.find(String(req.params.requestId));
    if (!record) {
      throw new AppError("NOT_FOUND", "Not found.");
    }
    const errorLog = telemetry.errorLog.find(e => e.requestId === record.requestId) ?? null;
    res.status(200).json({ ...record, errorLog });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/ops/errors", (req: Request, res: Response) => {
  try {
    authenticateSupport(getHeader(req, "authorization"));
    res.status(200).json(telemetry.errorLog.slice(-50).reverse());
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/ops/diagnostic-receipts/verify", (req: Request, res: Response) => {
  try {
    authenticateSupport(getHeader(req, "authorization"));
    res.status(200).json(verifyDiagnosticReceipt(req.body));
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Tenant side: issue a signed, content-free health snapshot to hand to support
app.post("/api/v2/support/diagnostic-receipts", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const result = await generateDiagnosticReceipt({
      who,
      actor,
      idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S10 / S11 / S12: Phase 5 Governance, Evidence & Lifecycle Endpoints
// -------------------------------------------------------------

// Commercial Entitlements for Tenant
app.get("/api/v2/entitlements", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const entitlements = getDefaultEntitlements(who.tenantId);
    res.status(200).json({
      tenantId: who.tenantId,
      entitlements
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Dual-gate Policy & Entitlement Resolution
app.get("/api/v2/policy/resolution", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const feature = String(req.query.feature || "INTERVENTION_APPROVAL");

    const out = await withTenant(who.tenantId, async (tx) => {
      return await canTenantFeature(tx, { feature, at: new Date() });
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Issue Content-Addressed Evidence Package
app.post("/api/v2/evidence-packages", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());

    const periodStart = req.body.periodStart || new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString();
    const periodEnd = req.body.periodEnd || new Date().toISOString();

    const out = await withTenant(who.tenantId, async (tx) => {
      const hRes = await tx.q("SELECT * FROM hazard WHERE tenant_id = $1 LIMIT 1", [who.tenantId]);
      const hazardId = req.body.hazardId || (hRes.rows[0]?.id);
      if (!hazardId) {
        throw new AppError("NOT_FOUND", "No hazard available to generate evidence package.");
      }
      return await issuePackage(tx, {
        hazardId,
        issuerPrincipalId: who.subject
      });
    });

    res.status(201).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// List Evidence Packages
app.get("/api/v2/evidence-packages", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const out = await withTenant(who.tenantId, async (tx) => {
      const res = await tx.q("SELECT * FROM evidence_package WHERE tenant_id = $1", [who.tenantId]);
      return res.rows;
    });
    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Get Evidence Package by ID
app.get("/api/v2/evidence-packages/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const out = await withTenant(who.tenantId, async (tx) => {
      return await getEvidencePackage(tx, String(req.params.id));
    });
    if (!out) {
      throw new AppError("NOT_FOUND", "Evidence package not found.");
    }
    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Ingest Targeted Source Correction (Marking Downstream Releases STALE)
app.post("/api/v2/corrections/ingest", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const { sourceRecordId, affectedStart, affectedEnd, reason } = req.body;

    const out = await withTenant(who.tenantId, async (tx) => {
      return await onCorrection(tx, {
        tenantId: who.tenantId,
        sourceRecordId: sourceRecordId || "rec-default-correction",
        revision: Number(req.body.revision) || 2,
        correctedAt: new Date().toISOString()
      });
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Acknowledge Correction
app.post("/api/v2/corrections/:id/acknowledge", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const out = await withTenant(who.tenantId, async (tx) => {
      return await acknowledgeCorrection(tx, String(req.params.id), who.subject, req.body.notes || "Acknowledged");
    });
    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Subject Rights Request (GDPR Art 17 Erasure)
app.post("/api/v2/lifecycle/rights-requests", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const { subjectPseudonym } = req.body;
    if (!subjectPseudonym) {
      throw new AppError("VALIDATION", "subjectPseudonym is required for rights request.");
    }

    const out = await withTenant(who.tenantId, async (tx) => {
      return await eraseSubject(tx, subjectPseudonym);
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S08 & S09: Phase 6 Bounded AI & Safe Action Execution Endpoints
// -------------------------------------------------------------

// AI Explain Release (Domain S08)
app.post("/api/v2/ai/explain-release", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const input = ExplainReleaseInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      return await runAiUseCase(tx, actor, "explain_release", {
        contextRefs: [{ type: "RELEASE", id: input.releaseId }],
        question: input.question
      });
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// AI Draft Cause Hypotheses (Domain S08)
app.post("/api/v2/ai/draft-cause", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const input = DraftCauseInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [input.hazardId, who.tenantId]);
      if (!hRes.rowCount || hRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Hazard not found for cause drafting.");
      }
      const hazard = hRes.rows[0];
      return await runAiUseCase(tx, actor, "draft_cause", {
        contextRefs: [{ type: "RELEASE", id: hazard.originating_release_id }],
        question: `Suggest organizational cause hypotheses for hazard: ${hazard.title}`
      });
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// AI Draft Control Parameters (Domain S08)
app.post("/api/v2/ai/draft-control", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    const input = DraftControlInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [input.hazardId, who.tenantId]);
      if (!hRes.rowCount || hRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Hazard not found for control drafting.");
      }
      const hazard = hRes.rows[0];
      return await runAiUseCase(tx, actor, "draft_control", {
        contextRefs: [{ type: "RELEASE", id: hazard.originating_release_id }],
        question: `Draft workplace risk controls for hazard: ${hazard.title}`
      });
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Accept AI Proposal (Domain S08)
app.post("/api/v2/ai/runs/:id/accept", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const out = await withTenant(who.tenantId, async (tx) => {
      return await acceptAiRun(tx, actor, String(req.params.id), req.body);
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Discard AI Proposal (Domain S08)
app.post("/api/v2/ai/runs/:id/discard", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const out = await withTenant(who.tenantId, async (tx) => {
      return await discardAiRun(tx, actor, String(req.params.id));
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// List AI Runs for Tenant
app.get("/api/v2/ai/runs", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const out = await withTenant(who.tenantId, async (tx) => {
      const res = await tx.q("SELECT * FROM ai_run WHERE tenant_id = $1 ORDER BY created_at DESC", [who.tenantId]);
      return res.rows;
    });
    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Kill Switches: Ops/Support and Tenant Inspection
app.get("/api/v2/ops/kill-switches", async (req: Request, res: Response) => {
  try {
    const out = await withTenant("00000000-0000-4000-a000-00000000000a", async (tx) => {
      return await getKillSwitches(tx);
    });
    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/ops/kill-switches", async (req: Request, res: Response) => {
  try {
    const input = KillSwitchInput.parse(req.body);
    const out = await withTenant("00000000-0000-4000-a000-00000000000a", async (tx) => {
      return await setKillSwitch(tx, input.scope, input.active, "ops.admin");
    });
    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Propose External Action with Grant Token (Domain S09)
app.post("/api/v2/actions/proposals", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const input = ActionProposalInput.parse(req.body);

    const out = await withTenant(who.tenantId, async (tx) => {
      const attempt = await createActionAttempt(tx, input);
      const grantToken = mintGrant({
        tenantId: who.tenantId,
        actor: who.subject,
        runId: crypto.randomUUID(),
        tool: input.tool,
        paramHash: attempt.paramHash,
        target: input.target,
        resourceVersion: input.resourceVersion,
        approvalRef: input.approvalRef
      });
      return { attempt, grantToken };
    });

    res.status(201).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Dispatch External Action (Domain S09)
app.post("/api/v2/actions/:id/dispatch", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const grantToken = getHeader(req, "x-action-grant") || req.body.grantToken;
    if (!grantToken) {
      throw new AppError("FORBIDDEN", "Action dispatch requires a signed action grant token.");
    }

    const { tool, target, params } = req.body;
    // Parameter-hash binding verification: catch mutations
    verifyGrant(grantToken, { tool, target, params: params || {} });

    const out = await withTenant(who.tenantId, async (tx) => {
      return await dispatchAttempt(tx, String(req.params.id), params || {});
    });

    res.status(200).json(out);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Final handler: body-parser and any unrouted error get the safe envelope, never Express's HTML/stack page
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return toErrorResponse(new AppError("VALIDATION", "The request body could not be parsed."), res);
  }
  return toErrorResponse(err, res);
});

// -------------------------------------------------------------
// Server Initialization
// -------------------------------------------------------------

// Only listen when run as the entrypoint, so tools can mount the app on an ephemeral port
const server = require.main === module
  ? app.listen(cfg.port, "0.0.0.0", () => {
    console.log(`\x1b[32m[Zoiko Abate Server] Running at http://localhost:${cfg.port}\x1b[0m`);
    console.log(`[Config] Environment: ${cfg.appEnv} | Client URL: ${cfg.clientUrl}`);
    console.log(`[Config] Fixed Clock: ${cfg.fixedClock}`);
  })
  : null;

export { app, server };
