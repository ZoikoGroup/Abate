// backend/src/routes/admin.ts
// Super Admin Platform Management Routes (/api/v2/admin/*)
// Enforces zero-impersonation: Super Admin manages platform & tenant lifecycle metadata only,
// and CANNOT read tenant workforce facts, measurements, identity_map, or bypass Privacy Release.

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { loadConfig, isDevTokenEnabled } from "../platform/config";
import { toErrorResponse, AppError } from "../platform/errors";
import { authenticateSuperAdmin, createSuperAdminToken } from "../domains/support";
import { withOps, withWorker, isPostgresRequired } from "../platform/db/with-tenant";
import { getWorkerMetrics } from "../worker/daemon";
import { buildSloReport } from "../platform/slo";
import { telemetry } from "../platform/telemetry";
import { evaluateOperationalAlerts } from "../platform/monitoring";
import { getObjectStore } from "../platform/object-store";
import { listAvailableSectors, getSectorMapping } from "../domains/lifecycle/sector-registry";
import { SECTOR_KEY_PATTERN } from "../domains/lifecycle/sector-pack";
import { getHeader, checkPgHealthSafe } from "./helpers";

const SuperAdminTokenBody = z.object({
  operator: z.string().min(2).max(120)
}).strict();

const CreateTenantBody = z.object({
  name: z.string().min(2).max(120),
  region: z.string().min(2).max(40).default("eu-west-2"),
  sectorKey: z.string().regex(SECTOR_KEY_PATTERN).default("LEGAL"),
  jurisdictionConfigRef: z.string().max(120).optional()
}).strict();

const UpdateTenantBody = z.object({
  name: z.string().min(2).max(120),
  region: z.string().min(2).max(40),
  jurisdictionConfigRef: z.string().max(120).nullable().optional()
}).strict();

const TenantStateBody = z.object({
  state: z.enum(["ACTIVE", "SUSPENDED"]),
  reason: z.string().min(5).max(500)
}).strict();

const AssignMembershipBody = z.object({
  externalSubject: z.string().min(3).max(160),
  kind: z.enum(["USER", "WORKLOAD"]).default("USER"),
  domainRole: z.enum(["RISK_OWNER", "CONTROL_OWNER", "REVIEWER", "EMPLOYER_ADMIN"]),
  organizationId: z.string().uuid().optional(),
  reason: z.string().min(3).max(500).optional()
}).strict();

const FeatureFlagBody = z.object({
  tenantId: z.string().uuid().nullable(),
  flag: z.enum(["planeBOutcomes", "aiWorkDesign", "aiProposals"]),
  enabled: z.boolean(),
  reason: z.string().min(3).max(500)
}).strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toNullableUuid = (val: string | null | undefined): string | null =>
  val && UUID_RE.test(val) ? val : null;

async function recordPlatformAudit(
  tx: { q: (sql: string, params?: any[]) => Promise<any> },
  args: {
    operator: string;
    role: string;
    action: string;
    targetType: string;
    targetId: string;
    reason?: string | null;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.q(
    `INSERT INTO platform_audit_event (
       id, operator, role, action, target_type, target_id, reason, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      crypto.randomUUID(),
      args.operator,
      args.role,
      args.action,
      args.targetType,
      args.targetId,
      args.reason ?? null,
      JSON.stringify(args.details ?? {})
    ]
  );
}

export function registerAdminRoutes(app: Express): void {
  // Dev-only Super Admin token issuance (refuses outside local/test)
  app.post("/api/v2/auth/super-admin-token", (req: Request, res: Response) => {
    try {
      if (!isDevTokenEnabled(loadConfig())) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      const { operator } = SuperAdminTokenBody.parse(req.body);
      const token = createSuperAdminToken({ operator });
      res.status(200).json({
        token,
        tokenType: "Bearer",
        expiresIn: "2h",
        operator,
        role: "SUPER_ADMIN",
        scope: "platform-super-admin"
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Platform Overview (system health, SLO, worker, tenant & principal summary counts)
  app.get("/api/v2/admin/overview", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const runtimeCfg = loadConfig();
      const pgOk = await checkPgHealthSafe();
      const storeHealth = await getObjectStore(runtimeCfg).health();
      const workerMetrics = getWorkerMetrics();
      const sloReport = buildSloReport(telemetry.snapshot());
      const alertReport = evaluateOperationalAlerts({
        cfg: runtimeCfg,
        sloReport,
        workerMetrics,
        deps: {
          databaseOk: pgOk,
          databaseRequired: isPostgresRequired(),
          objectStoreOk: storeHealth.ok,
          objectStoreMode: runtimeCfg.objectStoreMode
        }
      });

      const counts = await withOps(async (tx) => {
        const tenantsRes = await tx.q("SELECT id, state FROM tenant");
        const activeTenants = tenantsRes.rows.filter((t: any) => (t.state || "ACTIVE") === "ACTIVE").length;
        const suspendedTenants = tenantsRes.rows.filter((t: any) => t.state === "SUSPENDED").length;
        const auditRes = await tx.q("SELECT id FROM platform_audit_event");
        return {
          totalTenants: tenantsRes.rows.length,
          activeTenants,
          suspendedTenants,
          platformAuditCount: auditRes.rows.length
        };
      });

      const workerCounts = await withWorker(async (tx) => {
        const pendingRes = await tx.q("SELECT count(*)::int AS count FROM outbox_event WHERE published_at IS NULL AND state IN ('PENDING','PROCESSING')");
        const dlRes = await tx.q("SELECT count(*)::int AS count FROM dead_letter_event WHERE replayed_at IS NULL");
        return {
          pendingOutbox: Number(pendingRes.rows[0]?.count ?? 0),
          deadLetterCount: Number(dlRes.rows[0]?.count ?? 0)
        };
      });

      res.status(200).json({
        operator: admin.operator,
        role: admin.role,
        perimeter: "ZERO_IMPERSONATION_METADATA_ONLY",
        system: {
          appEnv: runtimeCfg.appEnv,
          databaseOk: pgOk,
          databaseRequired: isPostgresRequired(),
          objectStoreOk: storeHealth.ok,
          objectStoreMode: runtimeCfg.objectStoreMode,
          workerState: workerMetrics.state,
          workerHeartbeatAt: workerMetrics.heartbeatAt
        },
        counts: { ...counts, ...workerCounts },
        slo: sloReport,
        alerts: alertReport.alerts,
        alertSummary: {
          overallStatus: alertReport.overallStatus,
          ...alertReport.summary
        }
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // List all tenants (metadata only)
  app.get("/api/v2/admin/tenants", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdmin(getHeader(req, "authorization"));
      const items = await withOps(async (tx) => {
        const tRes = await tx.q("SELECT id, name, region, jurisdiction_config_ref, state, created_at FROM tenant");
        const secRes = await tx.q("SELECT tenant_id, sector_key, pack_key, updated_at FROM tenant_sector_setting");
        const secByTenant = new Map(secRes.rows.map((s: any) => [s.tenant_id, s]));
        return tRes.rows.map((t: any) => {
          const sec: any = secByTenant.get(t.id);
          return {
            id: t.id,
            name: t.name,
            region: t.region,
            state: t.state || "ACTIVE",
            jurisdictionConfigRef: t.jurisdiction_config_ref ?? null,
            sectorKey: sec?.sector_key || "LEGAL",
            packKey: sec?.pack_key || getSectorMapping("LEGAL")?.packKey || "generic",
            createdAt: t.created_at
          };
        });
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Create new tenant + root organization + initial sector pack setting
  app.post("/api/v2/admin/tenants", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const body = CreateTenantBody.parse(req.body);
      const pack = getSectorMapping(body.sectorKey);
      if (!pack) {
        throw new AppError("VALIDATION", `Unknown sector pack '${body.sectorKey}'.`);
      }

      const tenantId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      const created = await withOps(async (tx) => {
        await tx.q(
          `INSERT INTO tenant (id, name, region, jurisdiction_config_ref, state)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, body.name, body.region, body.jurisdictionConfigRef ?? null, "ACTIVE"]
        );
        await tx.q(
          `INSERT INTO organization (id, tenant_id, parent_id, name)
           VALUES ($1, $2, $3, $4)`,
          [orgId, tenantId, null, `${body.name} Root`]
        );
        await tx.q(
          `INSERT INTO tenant_sector_setting (tenant_id, sector_key, pack_key, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (tenant_id) DO UPDATE SET sector_key = EXCLUDED.sector_key, pack_key = EXCLUDED.pack_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, pack.sector, pack.packKey, toNullableUuid(admin.operator)]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "tenant.create",
          targetType: "tenant",
          targetId: tenantId,
          reason: "Platform tenant provisioning",
          details: { name: body.name, region: body.region, sectorKey: pack.sector, rootOrganizationId: orgId }
        });
        return {
          id: tenantId,
          name: body.name,
          region: body.region,
          state: "ACTIVE",
          jurisdictionConfigRef: body.jurisdictionConfigRef ?? null,
          sectorKey: pack.sector,
          packKey: pack.packKey,
          rootOrganizationId: orgId
        };
      });

      res.status(201).json(created);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Update tenant metadata
  app.patch("/api/v2/admin/tenants/:tenantId", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const tenantId = String(req.params.tenantId);
      const body = UpdateTenantBody.parse(req.body);
      const updated = await withOps(async (tx) => {
        const upd = await tx.q(
          `UPDATE tenant SET name = $1, region = $2, jurisdiction_config_ref = $3 WHERE id = $4`,
          [body.name, body.region, body.jurisdictionConfigRef ?? null, tenantId]
        );
        if (upd.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Tenant not found.");
        }
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "tenant.update",
          targetType: "tenant",
          targetId: tenantId,
          details: { name: body.name, region: body.region, jurisdictionConfigRef: body.jurisdictionConfigRef ?? null }
        });
        return { id: tenantId, ...body };
      });
      res.status(200).json(updated);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Activate or Suspend tenant
  app.post("/api/v2/admin/tenants/:tenantId/state", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const tenantId = String(req.params.tenantId);
      const body = TenantStateBody.parse(req.body);
      const updated = await withOps(async (tx) => {
        const upd = await tx.q(`UPDATE tenant SET state = $1 WHERE id = $2`, [body.state, tenantId]);
        if (upd.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Tenant not found.");
        }
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: body.state === "SUSPENDED" ? "tenant.suspend" : "tenant.activate",
          targetType: "tenant",
          targetId: tenantId,
          reason: body.reason,
          details: { state: body.state }
        });
        return { id: tenantId, state: body.state };
      });
      res.status(200).json(updated);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Set tenant sector pack
  app.put("/api/v2/admin/tenants/:tenantId/sector-pack", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const tenantId = String(req.params.tenantId);
      const sectorKey = z.string().regex(SECTOR_KEY_PATTERN).parse(req.body?.sectorKey);
      const pack = getSectorMapping(sectorKey);
      if (!pack) {
        throw new AppError("VALIDATION", `Unknown sector pack '${sectorKey}'.`);
      }
      await withOps(async (tx) => {
        await tx.q(
          `INSERT INTO tenant_sector_setting (tenant_id, sector_key, pack_key, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (tenant_id) DO UPDATE SET sector_key = EXCLUDED.sector_key, pack_key = EXCLUDED.pack_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, pack.sector, pack.packKey, toNullableUuid(admin.operator)]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "tenant.sector_pack.set",
          targetType: "tenant",
          targetId: tenantId,
          details: { sectorKey: pack.sector, packKey: pack.packKey }
        });
      });
      res.status(200).json({ tenantId, sectorKey: pack.sector, packKey: pack.packKey });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // List principals & memberships for a tenant (access metadata only)
  app.get("/api/v2/admin/tenants/:tenantId/principals", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdmin(getHeader(req, "authorization"));
      const tenantId = String(req.params.tenantId);
      const data = await withOps(async (tx) => {
        const pRes = await tx.q(`SELECT id, tenant_id, external_subject, kind FROM principal WHERE tenant_id = $1`, [tenantId]);
        const mRes = await tx.q(`SELECT id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to FROM effective_membership WHERE tenant_id = $1`, [tenantId]);
        const pMap = new Map(pRes.rows.map((p: any) => [p.id, p]));
        return mRes.rows.map((m: any) => {
          const p: any = pMap.get(m.principal_id);
          return {
            membershipId: m.id,
            principalId: m.principal_id,
            externalSubject: p?.external_subject || "unknown",
            kind: p?.kind || "USER",
            domainRole: m.domain_role,
            organizationId: m.organization_id,
            validFrom: m.valid_from,
            validTo: m.valid_to ?? null,
            active: !m.valid_to || new Date(m.valid_to).getTime() > Date.now()
          };
        });
      });
      res.status(200).json({ tenantId, items: data });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Provision principal & assign role membership
  app.post("/api/v2/admin/tenants/:tenantId/memberships", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const tenantId = String(req.params.tenantId);
      const body = AssignMembershipBody.parse(req.body);

      const created = await withOps(async (tx) => {
        const existingP = await tx.q(`SELECT id, tenant_id, external_subject, kind FROM principal WHERE tenant_id = $1`, [tenantId]);
        let principal = existingP.rows.find((p: any) => p.external_subject === body.externalSubject);
        if (!principal) {
          const pId = crypto.randomUUID();
          await tx.q(
            `INSERT INTO principal (id, tenant_id, external_subject, kind) VALUES ($1, $2, $3, $4)`,
            [pId, tenantId, body.externalSubject, body.kind]
          );
          principal = { id: pId, tenant_id: tenantId, external_subject: body.externalSubject, kind: body.kind };
        }

        let orgId = body.organizationId;
        if (!orgId) {
          const orgRes = await tx.q(`SELECT id FROM organization WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
          orgId = orgRes.rows[0]?.id;
          if (!orgId) {
            orgId = crypto.randomUUID();
            await tx.q(`INSERT INTO organization (id, tenant_id, parent_id, name) VALUES ($1, $2, $3, $4)`, [orgId, tenantId, null, "Default Root"]);
          }
        }

        const membershipId = crypto.randomUUID();
        const validFrom = new Date().toISOString();
        await tx.q(
          `INSERT INTO effective_membership (id, tenant_id, principal_id, organization_id, domain_role, valid_from)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [membershipId, tenantId, principal.id, orgId, body.domainRole, validFrom]
        );

        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "membership.assign",
          targetType: "effective_membership",
          targetId: membershipId,
          reason: body.reason ?? "Super Admin role assignment",
          details: { tenantId, externalSubject: body.externalSubject, domainRole: body.domainRole, organizationId: orgId }
        });

        return {
          membershipId,
          principalId: principal.id,
          externalSubject: body.externalSubject,
          kind: principal.kind,
          domainRole: body.domainRole,
          organizationId: orgId,
          validFrom,
          validTo: null,
          active: true
        };
      });

      res.status(201).json(created);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Revoke membership
  app.post("/api/v2/admin/tenants/:tenantId/memberships/:membershipId/revoke", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const tenantId = String(req.params.tenantId);
      const membershipId = String(req.params.membershipId);
      await withOps(async (tx) => {
        const upd = await tx.q(
          `UPDATE effective_membership SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond') WHERE id = $1`,
          [membershipId]
        );
        if (upd.rowCount === 0) {
          throw new AppError("NOT_FOUND", "Membership not found.");
        }
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "membership.revoke",
          targetType: "effective_membership",
          targetId: membershipId,
          reason: typeof req.body?.reason === "string" ? req.body.reason : "Revoked by Super Admin",
          details: { tenantId, membershipId }
        });
      });
      res.status(200).json({ membershipId, revoked: true });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Governance: Sector packs & jurisdiction registry
  app.get("/api/v2/admin/governance", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdmin(getHeader(req, "authorization"));
      const packs = listAvailableSectors();
      res.status(200).json({
        sectorPacks: packs.map((p) => {
          const full = getSectorMapping(p.sectorKey);
          return {
            sectorKey: p.sectorKey,
            packKey: p.packKey,
            displayName: p.displayName,
            status: p.status,
            version: "v1.0",
            reviewStatus: p.status === "LAUNCHED" ? "LEGAL_ACTIVE_PILOT_SCOPE" : "DRAFT_PENDING_PRODUCT_ADR",
            permittedClaims: full?.claimScope ?? [],
            restrictions: full?.cannotOverride ?? []
          };
        })
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Feature flags list & toggle
  app.get("/api/v2/admin/feature-flags", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdmin(getHeader(req, "authorization"));
      const items = await withOps(async (tx) => {
        const r = await tx.q(`SELECT tenant_id, flag, enabled, changed_by, changed_at FROM feature_flag`);
        return r.rows;
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/admin/feature-flags", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdmin(getHeader(req, "authorization"));
      const body = FeatureFlagBody.parse(req.body);
      const changedAt = new Date().toISOString();
      await withOps(async (tx) => {
        await tx.q(
          `INSERT INTO feature_flag (tenant_id, flag, enabled, changed_by, changed_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
          [body.tenantId, body.flag, body.enabled, admin.operator, changedAt]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "feature_flag.set",
          targetType: "feature_flag",
          targetId: `${body.tenantId ?? "global"}:${body.flag}`,
          reason: body.reason,
          details: { tenantId: body.tenantId, flag: body.flag, enabled: body.enabled }
        });
      });
      res.status(200).json({ tenantId: body.tenantId, flag: body.flag, enabled: body.enabled });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Immutable platform audit log
  app.get("/api/v2/admin/audit", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdmin(getHeader(req, "authorization"));
      const items = await withOps(async (tx) => {
        const r = await tx.q(
          `SELECT id, occurred_at, operator, role, action, target_type, target_id, reason, details
           FROM platform_audit_event
           ORDER BY occurred_at DESC
           LIMIT 100`
        );
        return r.rows;
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });
}
