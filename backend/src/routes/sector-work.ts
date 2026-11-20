// backend/src/routes/sector-work.ts
// Sector work-item endpoints.
//   /api/v2/sector/work-items/*  generic, driven by the tenant's active sector pack
//   /api/v2/sector/legal/*       legal-named aliases kept for existing clients; legal tenants only
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { AppError, toErrorResponse } from "../platform/errors";
import { withTenant } from "../platform/db/with-tenant";
import { authenticate, authorize, resolveActor } from "../domains/tenant/auth";
import {
  assertTenantHasLegalPack,
  getSectorMapping,
  resolveTenantSectorProfile
} from "../domains/lifecycle/sector";
import {
  evaluateSectorFatigue,
  mapToNeutralWorkItem,
  parseSectorWorkItem
} from "../domains/sector-work";
import {
  LegalMatterSchema,
  assertLegalBoundaryCompliance,
  evaluateLegalFatigueSurge,
  mapMatterToWorkItem,
  workItemToLegalMatter
} from "../domains/sector-legal";
import { listSeededWorkItems } from "../fixtures/sector-work-items";

export interface SectorWorkRouteDeps {
  getHeader: (req: Request, name: string) => string | null;
}

const IntervalsSchema = z.array(
  z.object({ startUtc: z.string().datetime(), endUtc: z.string().datetime() })
    .refine(i => Date.parse(i.endUtc) > Date.parse(i.startUtc), { message: "endUtc must be after startUtc" })
).max(500).optional();

const GenericFatigueBody = z.object({
  workItemId: z.string().min(1).max(128),
  intervals: IntervalsSchema,
  jurisdictionCode: z.string().regex(/^[A-Z][A-Z0-9_-]{1,31}$/).optional(),
  simulatedItem: z.object({
    unit: z.string().min(1).max(128).optional(),
    demandWindow: z.string().min(1).max(128).optional()
  }).optional()
}).strict();

const LegalFatigueBody = z.object({
  matterId: z.string().min(1).max(128),
  intervals: IntervalsSchema
}).strict();

/** Synthetic default when the caller sends no intervals: three consecutive evenings past 20:00 UTC. */
const DEFAULT_SURGE_INTERVALS = [
  { startUtc: "2026-03-02T09:00:00Z", endUtc: "2026-03-02T22:30:00Z" },
  { startUtc: "2026-03-03T09:00:00Z", endUtc: "2026-03-03T23:15:00Z" },
  { startUtc: "2026-03-04T09:00:00Z", endUtc: "2026-03-04T22:00:00Z" }
];

export function registerSectorWorkRoutes(app: Express, deps: SectorWorkRouteDeps): void {
  const { getHeader } = deps;

  /** Resolves the caller's tenant sector and fails closed with 403 when only the neutral baseline is active. */
  async function requireActiveSector(who: { tenantId: string }) {
    const profile = await withTenant(who.tenantId, async (tx) => resolveTenantSectorProfile(tx, who.tenantId));
    if (!profile.packActive) {
      throw new AppError("FORBIDDEN", "No sector pack is enabled for this tenant.");
    }
    const mapping = getSectorMapping(profile.sectorKey);
    if (!mapping) {
      throw new AppError("FORBIDDEN", "The tenant's sector pack is not available.");
    }
    return { profile, mapping };
  }

  // ---------------------------------------------------------------------------------------------
  // Generic endpoints
  // ---------------------------------------------------------------------------------------------

  app.get("/api/v2/sector/work-items", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const { profile } = await requireActiveSector(who);
      res.status(200).json({
        sectorKey: profile.sectorKey,
        vocabulary: profile.vocabulary,
        items: listSeededWorkItems(who.tenantId, profile.sectorKey)
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/sector/work-items/map", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorize(actor, "org.create");
      const { profile, mapping } = await requireActiveSector(who);
      const workItem = parseSectorWorkItem(mapping, req.body);
      res.status(200).json({
        sectorKey: profile.sectorKey,
        workItem,
        neutralWorkItem: mapToNeutralWorkItem(workItem),
        sectorPack: mapping.packKey,
        complianceStatus: "VALIDATED"
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/sector/work-items/fatigue-check", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const { profile, mapping } = await requireActiveSector(who);
      const { workItemId, intervals, jurisdictionCode, simulatedItem } = GenericFatigueBody.parse(req.body ?? {});
      let item = listSeededWorkItems(who.tenantId, profile.sectorKey).find(i => i.externalRef === workItemId);
      if (!item && (simulatedItem || workItemId.startsWith("SIM-"))) {
        item = {
          externalRef: workItemId,
          title: `Simulated ${profile.vocabulary.workItem}`,
          unit: simulatedItem?.unit || profile.workItemUnits?.[0] || "DEFAULT_UNIT",
          demandWindow: simulatedItem?.demandWindow || profile.highDemandWindows?.[0] || profile.demandWindows?.[0] || "SURGE_CAPACITY",
          accountableReviewerId: "00000000-0000-4000-a000-000000000001",
          activeWindowStart: new Date(Date.now() - 14 * 86400000).toISOString(),
          activeWindowEnd: new Date().toISOString()
        };
      }
      if (!item) {
        throw new AppError("NOT_FOUND", "Work item not found for this tenant.");
      }
      const used = Array.isArray(intervals) && intervals.length > 0 ? intervals : DEFAULT_SURGE_INTERVALS;
      res.status(200).json(evaluateSectorFatigue(mapping, item, used, { jurisdictionCode }));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/sector/rules", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const { profile, mapping } = await requireActiveSector(who);
      res.status(200).json({
        sectorKey: profile.sectorKey,
        packKey: mapping.packKey,
        packStatus: mapping.status,
        claimScope: mapping.claimScope,
        rules: mapping.rules,
        jurisdictionOverlays: mapping.jurisdictionOverlays,
        forbiddenFields: mapping.forbidden,
        cannotOverride: mapping.cannotOverride
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Legal aliases. Same behaviour and response shapes as before, now backed by the generic module.
  // ---------------------------------------------------------------------------------------------

  app.get("/api/v2/sector/legal/matters", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      await withTenant(who.tenantId, async (tx) => assertTenantHasLegalPack(tx, who.tenantId));
      const matters = listSeededWorkItems(who.tenantId, "LEGAL").map(workItemToLegalMatter);
      res.status(200).json({ items: matters });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/sector/legal/matters/map", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorize(actor, "org.create"); // Risk owners and practice heads
      await withTenant(who.tenantId, async (tx) => assertTenantHasLegalPack(tx, who.tenantId));

      // 1. Constitutional boundary check, 2. strict schema, 3. neutral work item
      assertLegalBoundaryCompliance(req.body);
      const matter = LegalMatterSchema.parse(req.body);
      res.status(200).json({
        matter,
        workItem: mapMatterToWorkItem(matter),
        sectorPack: "sector-legal@v1",
        complianceStatus: "VALIDATED"
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/sector/legal/fatigue-check", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      await withTenant(who.tenantId, async (tx) => assertTenantHasLegalPack(tx, who.tenantId));
      const { matterId, intervals } = LegalFatigueBody.parse(req.body ?? {});
      const item = listSeededWorkItems(who.tenantId, "LEGAL").find(i => i.externalRef === matterId);
      if (!item) {
        throw new AppError("NOT_FOUND", "Matter not found for this tenant.");
      }
      const used = Array.isArray(intervals) && intervals.length > 0 ? intervals : DEFAULT_SURGE_INTERVALS;
      res.status(200).json(evaluateLegalFatigueSurge(workItemToLegalMatter(item), used));
    } catch (err) {
      toErrorResponse(err, res);
    }
  });
}
