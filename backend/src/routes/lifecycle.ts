// backend/src/routes/lifecycle.ts
import type { Express, Request, Response } from "express";
import { toErrorResponse, AppError } from "../platform/errors";
import { authenticate, resolveActor, authorize } from "../domains/tenant/auth";
import { withTenant } from "../platform/db/with-tenant";
import { applyCursorPagination, setPaginationHeaders, validateAllowedQueryParams } from "../platform/pagination";
import { RightsRequestInputSchema, CorrectionInputSchema, AcknowledgeCorrectionInputSchema } from "../contracts/governance";
import {
  SetRetentionClassInput,
  PlaceLegalHoldInput,
  ReleaseLegalHoldInput,
  RunRetentionInput
} from "../contracts/retention";
import {
  getJurisdictionCoverage,
  listJurisdictionPackVersions,
  getRetentionState,
  previewRetention,
  setRetentionClass,
  placeLegalHold,
  releaseLegalHold,
  runRetention,
  canTenantFeature,
  getDefaultEntitlements,
  resolvePolicy,
  issuePackage,
  getEvidencePackage,
  verifyStoredEvidencePackage,
  requestErasure,
  recordCorrection,
  acknowledgeCorrection
} from "../domains/lifecycle";
import { getHeader, parseAt, parseLimit } from "./helpers";

export function registerLifecycleRoutes(app: Express): void {
  // -------------------------------------------------------------
  // Phase 5 (B5): Jurisdiction Packs, Retention & Legal Hold
  // -------------------------------------------------------------


  // Jurisdiction pack in effect for the tenant at a point in time (defaults to now)
  app.get("/api/v2/jurisdiction/coverage", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
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
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      res.status(200).json(await listJurisdictionPackVersions({ who, actor }));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Retention classes, legal holds, run receipts and tombstone digests
  app.get("/api/v2/retention", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      res.status(200).json(await getRetentionState({ who, actor }));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Dry run: what a retention run would do now, without writing
  app.get("/api/v2/retention/preview", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const { dataCategory } = RunRetentionInput.parse({ dataCategory: req.query.dataCategory ?? "WORK_FACT" });
      res.status(200).json(await previewRetention({ who, actor, dataCategory }));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/retention/classes", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
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
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
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

  app.post(["/api/v2/legal-holds", "/api/v2/lifecycle/holds"], async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
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

  app.post(["/api/v2/legal-holds/:id/release", "/api/v2/lifecycle/holds/:id/release"], async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
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

  // Commercial Entitlements for Tenant
  app.get("/api/v2/entitlements", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "entitlements.read");
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
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "policy.read");
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
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const out = await withTenant(who.tenantId, async (tx) => {
        const hRes = await tx.q("SELECT * FROM hazard WHERE tenant_id = $1 LIMIT 1", [who.tenantId]);
        const hazardId = req.body.hazardId || (hRes.rows[0]?.id);
        if (!hazardId) {
          throw new AppError("NOT_FOUND", "No hazard available to generate evidence package.");
        }
        return await issuePackage(tx, {
          hazardId,
          // evidence_package.issuer_principal_id is a uuid: the resolved principal, never the token's subject string
          issuerPrincipalId: actor.principalId
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
      validateAllowedQueryParams(req, ["limit", "cursor", "state"]);
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const filterState = typeof req.query.state === "string" ? req.query.state : undefined;
      const rows = await withTenant(who.tenantId, async (tx) => {
        const result = await tx.q(`SELECT * FROM evidence_package WHERE tenant_id = $1 ORDER BY issued_at DESC LIMIT 500`, [who.tenantId]);
        return result.rows.filter((p: any) => !filterState || p.state === filterState);
      });
      const page = applyCursorPagination(rows, {
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit: parseLimit(req, 100, 500),
        getKey: (p: any) => String(p.id)
      });
      setPaginationHeaders(res, page);
      res.status(200).json(page.items);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Get Evidence Package by ID
  app.get("/api/v2/evidence-packages/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "evidence_package.read");
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

  // Verify Evidence Package Objects & Manifest Against Active ObjectStore
  app.get("/api/v2/evidence-packages/:id/verify", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      authorize(await resolveActor(who.tenantId, who.subject, new Date(), who.role), "evidence_package.read");
      const out = await withTenant(who.tenantId, async (tx) => {
        return await verifyStoredEvidencePackage(tx, String(req.params.id));
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
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const result = await recordCorrection({
        who,
        actor,
        input: CorrectionInputSchema.parse(req.body),
        idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Acknowledge Correction
  app.post("/api/v2/corrections/:id/acknowledge", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const result = await acknowledgeCorrection({
        who,
        actor,
        correctionId: String(req.params.id),
        input: AcknowledgeCorrectionInputSchema.parse(req.body),
        idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Subject Rights Request (GDPR Art 17 Erasure)
  app.post("/api/v2/lifecycle/rights-requests", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const result = await requestErasure({
        who,
        actor,
        input: RightsRequestInputSchema.parse(req.body),
        idempotencyKey: getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key")
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

}
