// backend/src/routes/admin.ts
// Platform Super Admin Routes (/api/v2/admin/*)
// Enforces:
// - Dedicated least-privilege DB role `abate_platform_admin` via withPlatformAdmin()
// - Zero-impersonation & zero tenant business/protected table access
// - Short session lifetime, separate HttpOnly SameSite=Strict admin cookie, CSRF check, optional IP allow-list
// - Step-up re-authentication (401 on missing/expired) for destructive actions
// - Four-eyes approval (second distinct SUPER_ADMIN; self-approval refused 403; replay refused 409)
// - Mandatory free-text reason on every admin write & append-only platform_audit_event logging
// - Preview sector packs strictly blocked; no RATIFIED dossier action

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { loadConfig, isDevTokenEnabled } from "../platform/config";
import { toErrorResponse, AppError } from "../platform/errors";
import {
  authenticateSuperAdminRequest,
  authenticateSuperAdmin,
  assertStepUpRecent,
  createSuperAdminToken,
  createAdminOidcSessionCookieToken,
  setAdminSessionCookies,
  formatClearAdminSessionCookies,
  maskSubjectIdentifier,
  pseudonymizePrincipalRef,
  type SupportIdentity
} from "../domains/support";
import { withPlatformAdmin, withWorker, isPostgresRequired, type Tx } from "../platform/db/with-tenant";
import { getWorkerMetrics } from "../worker/daemon";
import { buildSloReport } from "../platform/slo";
import { telemetry } from "../platform/telemetry";
import { evaluateOperationalAlerts } from "../platform/monitoring";
import { getObjectStore } from "../platform/object-store";
import { listAvailableSectors, getSectorMapping } from "../domains/lifecycle/sector-registry";
import { SECTOR_KEY_PATTERN } from "../domains/lifecycle/sector-pack";
import { getHeader, checkPgHealthSafe, parseLimit } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toNullableUuid = (val: string | null | undefined): string | null =>
  val && UUID_RE.test(val) ? val : null;

const SHARED_ACCOUNT_RE = /^(admin|superadmin|root|support|ops|system|shared|service|bot)(@|$)/i;
const PRIVACY_OVERRIDE_KEY_RE = /(privacy|floor|k_?anonym|suppress|unmask|reidentify|surveillance|individual)/i;

const SuperAdminTokenBody = z.object({
  operator: z.string().trim().min(3).max(120),
  stepUp: z.boolean().optional()
}).strict();

const StepUpBody = z.object({
  confirmation: z.string().trim().min(3).max(120).optional(),
  mfaCode: z.string().trim().min(4).max(32).optional(),
  idToken: z.string().trim().min(20).max(8192).optional()
}).strict();

const AdminOidcExchangeBody = z.object({
  idToken: z.string().trim().min(20).max(8192)
}).strict();

const CreateTenantBody = z.object({
  name: z.string().trim().min(2).max(120),
  region: z.string().trim().min(2).max(40).default("eu-west-2"),
  sectorKey: z.string().regex(SECTOR_KEY_PATTERN).default("LEGAL"),
  jurisdictionConfigRef: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const UpdateTenantBody = z.object({
  name: z.string().trim().min(2).max(120),
  region: z.string().trim().min(2).max(40),
  jurisdictionConfigRef: z.string().trim().max(120).nullable().optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const TenantStateBody = z.object({
  state: z.enum(["ACTIVE", "SUSPENDED"]),
  reason: z.string().trim().min(5).max(500)
}).strict();

const OffboardTenantBody = z.object({
  reason: z.string().trim().min(10).max(500)
}).strict();

const SetSectorPackBody = z.object({
  sectorKey: z.string().regex(SECTOR_KEY_PATTERN),
  reason: z.string().trim().min(5).max(500)
}).strict();

// Separation rule: Super Admin may only bootstrap a tenant's initial EMPLOYER_ADMIN,
// never workflow approval roles (APPROVER, RISK_OWNER, CONTROL_OWNER, REVIEWER).
const AssignMembershipBody = z.object({
  externalSubject: z.string().trim().min(3).max(160),
  kind: z.enum(["USER", "WORKLOAD"]).default("USER"),
  domainRole: z.string().trim().min(2).max(60),
  organizationId: z.string().uuid().optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const RevokeMembershipBody = z.object({
  reason: z.string().trim().min(5).max(500)
}).strict();

const FeatureFlagBody = z.object({
  tenantId: z.string().uuid().nullable(),
  flag: z.enum(["planeBOutcomes", "aiWorkDesign", "aiProposals"]),
  enabled: z.boolean(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const PlatformUserCreateBody = z.object({
  subject: z.string().trim().min(4).max(160),
  displayName: z.string().trim().min(2).max(120),
  platformRole: z.enum(["SUPER_ADMIN", "OPS_SUPPORT"]),
  breakGlass: z.boolean().optional().default(false),
  reason: z.string().trim().min(5).max(500)
}).strict();

const PlatformUserRoleBody = z.object({
  platformRole: z.enum(["SUPER_ADMIN", "OPS_SUPPORT"]),
  reason: z.string().trim().min(5).max(500)
}).strict();

const PlatformUserDisableBody = z.object({
  reason: z.string().trim().min(5).max(500)
}).strict();

const EntitlementBody = z.object({
  tenantId: z.string().uuid(),
  featureKey: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  enabled: z.boolean(),
  notes: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const AiQuotaConfigBody = z.object({
  monthlyBudgetMinor: z.number().int().min(0).max(50_000_000),
  reason: z.string().trim().min(5).max(500)
}).strict();

const AdminKillSwitchBody = z.object({
  scope: z.string().trim().min(3).max(120),
  active: z.boolean(),
  reason: z.string().trim().min(5).max(500),
  expiresAt: z.string().datetime().nullable().optional()
}).strict();

const ApprovalDecisionBody = z.object({
  reason: z.string().trim().min(5).max(500)
}).strict();

const AuditExportBody = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  reason: z.string().trim().min(5).max(500),
  operator: z.string().trim().max(120).optional(),
  action: z.string().trim().max(120).optional(),
  targetType: z.string().trim().max(80).optional()
}).strict();

function parseIfMatch(req: Request): number | null {
  const raw = getHeader(req, "if-match");
  if (!raw) return null;
  const cleaned = raw.replace(/^W\//, "").replace(/^"|"$/g, "").trim();
  const num = Number(cleaned);
  if (!Number.isInteger(num) || num < 1) {
    throw new AppError("VALIDATION", "Header 'If-Match' must be a positive integer resource version.");
  }
  return num;
}

function assertVersionMatch(req: Request, currentVersion: number, label: string): void {
  const expected = parseIfMatch(req);
  if (expected !== null && expected !== currentVersion) {
    throw new AppError(
      "CONFLICT",
      `Stale version conflict on ${label}: expected version ${expected}, current version is ${currentVersion}. Reload and retry.`
    );
  }
}

function assertValidUuidParam(val: string, label: string): void {
  if (!UUID_RE.test(val)) {
    throw new AppError("NOT_FOUND", `${label} not found.`);
  }
}

function assertEnableableSectorPack(sectorKey: string) {
  const pack = getSectorMapping(sectorKey);
  if (!pack) {
    throw new AppError("VALIDATION", `Unknown sector pack '${sectorKey}'.`);
  }
  if (pack.status !== "BASELINE" && pack.status !== "LAUNCHED") {
    throw new AppError(
      "FORBIDDEN",
      `Sector pack '${sectorKey}' is '${pack.status.toLowerCase()}' (preview, not enabled) and cannot be enabled.`
    );
  }
  return pack;
}

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
    requestId?: string | null;
    approver?: string | null;
    stepUpVerified?: boolean;
  }
): Promise<void> {
  await tx.q(
    `INSERT INTO platform_audit_event (
       id, operator, role, action, target_type, target_id, reason, details, request_id, approver, step_up_verified
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      crypto.randomUUID(),
      args.operator,
      args.role,
      args.action,
      args.targetType,
      args.targetId,
      args.reason ?? null,
      JSON.stringify(args.details ?? {}),
      args.requestId ?? null,
      args.approver ?? null,
      Boolean(args.stepUpVerified)
    ]
  );
}

async function createFourEyesRequest(
  tx: Tx,
  args: {
    admin: SupportIdentity;
    actionType: string;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
    reason: string;
    requestId: string | null;
  }
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const ins = await tx.q(
    `INSERT INTO admin_approval_request (
       id, action_type, target_type, target_id, payload, reason, requested_by, expires_at, request_id
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING id, action_type, target_type, target_id, payload, reason, requested_by, requested_at, status, expires_at, request_id, version`,
    [
      id,
      args.actionType,
      args.targetType,
      args.targetId,
      JSON.stringify(args.payload),
      args.reason,
      args.admin.operator,
      expiresAt,
      args.requestId
    ]
  );
  await recordPlatformAudit(tx, {
    operator: args.admin.operator,
    role: args.admin.role,
    action: `approval.requested:${args.actionType}`,
    targetType: args.targetType,
    targetId: args.targetId,
    reason: args.reason,
    details: { approvalRequestId: id, actionType: args.actionType },
    requestId: args.requestId,
    stepUpVerified: true
  });
  return ins.rows[0] ?? {
    id,
    action_type: args.actionType,
    target_type: args.targetType,
    target_id: args.targetId,
    payload: args.payload,
    reason: args.reason,
    requested_by: args.admin.operator,
    status: "PENDING",
    expires_at: expiresAt,
    request_id: args.requestId,
    version: 1
  };
}

async function executeApprovedAction(
  tx: Tx,
  approval: any,
  approver: SupportIdentity,
  decisionReason: string,
  requestId: string | null
): Promise<Record<string, unknown>> {
  const payload = typeof approval.payload === "string" ? JSON.parse(approval.payload) : (approval.payload || {});
  const actionType = String(approval.action_type);

  if (actionType === "tenant.suspend") {
    const upd = await tx.q(
      `UPDATE tenant SET state = $1, version = version + 1 WHERE id = $2`,
      ["SUSPENDED", approval.target_id]
    );
    if (upd.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "tenant.suspend",
      targetType: "tenant",
      targetId: approval.target_id,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { state: "SUSPENDED", approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { id: approval.target_id, state: "SUSPENDED" };
  }

  if (actionType === "tenant.offboard.request") {
    const upd = await tx.q(
      `UPDATE tenant SET offboard_requested_at = now(), offboard_reason = $1, version = version + 1 WHERE id = $2`,
      [approval.reason, approval.target_id]
    );
    if (upd.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "tenant.offboard.request",
      targetType: "tenant",
      targetId: approval.target_id,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { workflow: "RETENTION_LEGAL_HOLD_TOMBSTONE", approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { id: approval.target_id, offboardRequested: true };
  }

  if (actionType === "sector_pack.enable") {
    const pack = assertEnableableSectorPack(String(payload.sectorKey));
    await tx.q(
      `INSERT INTO tenant_sector_setting (tenant_id, sector_key, pack_key, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id) DO UPDATE SET sector_key = EXCLUDED.sector_key, pack_key = EXCLUDED.pack_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [approval.target_id, pack.sector, pack.packKey, toNullableUuid(approval.requested_by)]
    );
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "tenant.sector_pack.set",
      targetType: "tenant",
      targetId: approval.target_id,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { sectorKey: pack.sector, packKey: pack.packKey, approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { tenantId: approval.target_id, sectorKey: pack.sector, packKey: pack.packKey };
  }

  if (actionType === "feature_flag.enable") {
    const changedAt = new Date().toISOString();
    await tx.q(
      `INSERT INTO feature_flag (tenant_id, flag, enabled, changed_by, changed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [payload.tenantId ?? null, payload.flag, true, approval.requested_by, changedAt]
    );
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "feature_flag.set",
      targetType: "feature_flag",
      targetId: approval.target_id,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { tenantId: payload.tenantId ?? null, flag: payload.flag, enabled: true, approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { tenantId: payload.tenantId ?? null, flag: payload.flag, enabled: true };
  }

  if (actionType === "ai.kill_switch.set") {
    const changedAt = new Date().toISOString();
    await tx.q(
      `INSERT INTO ai_kill_switch (scope, active, changed_by, changed_at, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope) DO UPDATE SET active = EXCLUDED.active, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at`,
      [payload.scope, Boolean(payload.active), approval.requested_by, changedAt, approval.reason, payload.expiresAt ?? null]
    );
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "ai.kill_switch.set",
      targetType: "ai_kill_switch",
      targetId: String(payload.scope),
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { scope: payload.scope, active: Boolean(payload.active), expiresAt: payload.expiresAt ?? null, approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { scope: payload.scope, active: Boolean(payload.active), expiresAt: payload.expiresAt ?? null };
  }

  if (actionType === "platform_user.create") {
    const newId = String(payload.id || crypto.randomUUID());
    await tx.q(
      `INSERT INTO platform_user (id, subject, display_name, platform_role, break_glass)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId, payload.subject, payload.displayName, payload.platformRole, Boolean(payload.breakGlass)]
    );
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "platform_user.create",
      targetType: "platform_user",
      targetId: newId,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { subject: payload.subject, platformRole: payload.platformRole, breakGlass: Boolean(payload.breakGlass), approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { id: newId, subject: payload.subject, platformRole: payload.platformRole, status: "ACTIVE" };
  }

  if (actionType === "platform_user.role.change") {
    const upd = await tx.q(
      `UPDATE platform_user SET platform_role = $1, updated_at = now(), version = version + 1 WHERE id = $2`,
      [payload.platformRole, approval.target_id]
    );
    if (upd.rowCount === 0) throw new AppError("NOT_FOUND", "Platform user not found.");
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "platform_user.role.change",
      targetType: "platform_user",
      targetId: approval.target_id,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { platformRole: payload.platformRole, approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { id: approval.target_id, platformRole: payload.platformRole };
  }

  if (actionType === "platform_user.disable") {
    const targetRes = await tx.q(`SELECT id, platform_role, status, break_glass FROM platform_user WHERE id = $1`, [approval.target_id]);
    if (!targetRes.rowCount || targetRes.rowCount === 0) throw new AppError("NOT_FOUND", "Platform user not found.");
    const target = targetRes.rows[0];
    if (target.platform_role === "SUPER_ADMIN" && target.status === "ACTIVE" && !target.break_glass) {
      const allPu = await tx.q(`SELECT id, platform_role, status, break_glass FROM platform_user`);
      const activeNamedSuperAdmins = allPu.rows.filter(
        (r: any) => r.platform_role === "SUPER_ADMIN" && r.status === "ACTIVE" && !r.break_glass
      );
      if (activeNamedSuperAdmins.length <= 2) {
        throw new AppError(
          "CONFLICT",
          "Four-eyes deadlock guard: at least two active named SUPER_ADMIN accounts must remain before disabling another SUPER_ADMIN."
        );
      }
    }
    const upd = await tx.q(
      `UPDATE platform_user SET status = $1, updated_at = now(), version = version + 1 WHERE id = $2`,
      ["DISABLED", approval.target_id]
    );
    if (upd.rowCount === 0) throw new AppError("NOT_FOUND", "Platform user not found.");
    await recordPlatformAudit(tx, {
      operator: approval.requested_by,
      role: "SUPER_ADMIN",
      action: "platform_user.disable",
      targetType: "platform_user",
      targetId: approval.target_id,
      reason: `${approval.reason} [Approved: ${decisionReason}]`,
      details: { status: "DISABLED", approvalRequestId: approval.id },
      requestId,
      approver: approver.operator,
      stepUpVerified: true
    });
    return { id: approval.target_id, status: "DISABLED" };
  }

  throw new AppError("VALIDATION", `Unsupported approval action '${actionType}'.`);
}

export function registerAdminRoutes(app: Express): void {
  // Dev-only Super Admin token & SameSite=Strict cookie issuance (refuses outside local/test)
  app.post("/api/v2/auth/super-admin-token", (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      if (!isDevTokenEnabled(cfg)) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      const { operator, stepUp } = SuperAdminTokenBody.parse(req.body);
      const stepUpAt = stepUp ? Math.floor(Date.now() / 1000) : null;
      const token = createSuperAdminToken({ operator, stepUpAt, mfaVerified: true });
      const csrfToken = setAdminSessionCookies(res, token, cfg);
      res.status(200).json({
        token,
        tokenType: "Bearer",
        expiresIn: `${cfg.adminSessionTtlSeconds}s`,
        expiresInSeconds: cfg.adminSessionTtlSeconds,
        stepUpWindowSeconds: cfg.adminStepUpWindowSeconds,
        stepUpVerified: Boolean(stepUpAt),
        csrfToken,
        operator,
        role: "SUPER_ADMIN",
        scope: "platform-super-admin"
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Admin session logout (clears dedicated HttpOnly SameSite=Strict admin cookies)
  app.post("/api/v2/admin/session/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", formatClearAdminSessionCookies(loadConfig()));
    res.status(204).send();
  });

  // Hardened OIDC Super Admin login exchange: verifies RS256/ES256 OIDC JWT with MFA (amr/acr) and auth_time,
  // and issues dedicated HttpOnly SameSite=Strict admin session + CSRF cookies (works in staging/production).
  app.post("/api/v2/admin/session/oidc/exchange", async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      const { idToken } = AdminOidcExchangeBody.parse(req.body);
      const identity = await authenticateSuperAdmin(`Bearer ${idToken}`);
      if (identity.authMethod !== "oidc") {
        throw new AppError("UNAUTHENTICATED", "Asymmetric OIDC JWT with MFA is required for OIDC admin session exchange.");
      }
      const remainingSec = identity.exp
        ? Math.max(60, Math.min(cfg.adminSessionTtlSeconds, Math.floor(identity.exp - Date.now() / 1000)))
        : cfg.adminSessionTtlSeconds;
      const cookieJwt = createAdminOidcSessionCookieToken(
        { operator: identity.operator, stepUpAt: identity.stepUpAt, mfaVerified: identity.mfaVerified },
        remainingSec,
        cfg
      );
      const csrfToken = setAdminSessionCookies(res, cookieJwt, cfg);
      const nowSec = Math.floor(Date.now() / 1000);
      const stepUpActive = Boolean(identity.stepUpAt && (nowSec - identity.stepUpAt) <= cfg.adminStepUpWindowSeconds);
      res.status(200).json({
        authenticated: true,
        authMethod: "oidc",
        operator: identity.operator,
        role: "SUPER_ADMIN",
        scope: "platform-super-admin",
        mfaVerified: identity.mfaVerified,
        stepUpVerified: stepUpActive,
        stepUpAt: identity.stepUpAt,
        stepUpExpiresAt: identity.stepUpAt ? new Date((identity.stepUpAt + cfg.adminStepUpWindowSeconds) * 1000).toISOString() : null,
        expiresInSeconds: remainingSec,
        csrfToken
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Step-up re-authentication for destructive actions:
  // - In staging/production (!isDevTokenEnabled): requires a real IdP OIDC JWT (via Authorization header or body.idToken)
  //   with verified MFA (amr/acr) and recent IdP auth_time within ADMIN_STEP_UP_WINDOW_SECONDS; rotates admin_oidc_session cookie (never mints dev HS256 tokens).
  // - In local/test (dev tokens enabled): stamps fresh step_up_at for local verification and E2E flows.
  app.post("/api/v2/admin/session/step-up", async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      const admin = await authenticateSuperAdminRequest(req);
      const body = StepUpBody.parse(req.body || {});
      const requestId = String(res.locals.requestId || "");
      const nowSec = Math.floor(Date.now() / 1000);

      if (!isDevTokenEnabled(cfg) || admin.authMethod === "oidc" || body.idToken) {
        let verified = admin;
        if (body.idToken) {
          const fresh = await authenticateSuperAdmin(`Bearer ${body.idToken}`);
          if (fresh.authMethod !== "oidc") {
            throw new AppError("UNAUTHENTICATED", "Step-up idToken must be an asymmetric IdP OIDC JWT.");
          }
          if (fresh.operator.toLowerCase() !== admin.operator.toLowerCase()) {
            throw new AppError("FORBIDDEN", "Step-up OIDC identity does not match the active Super Admin session.");
          }
          verified = fresh;
        }
        if (verified.authMethod !== "oidc") {
          throw new AppError("UNAUTHENTICATED", "OIDC re-authentication with MFA and fresh auth_time is required when dev tokens are disabled.");
        }
        assertStepUpRecent(verified, cfg);
        const cookieJwt = createAdminOidcSessionCookieToken(
          { operator: verified.operator, stepUpAt: verified.stepUpAt, mfaVerified: verified.mfaVerified },
          cfg.adminSessionTtlSeconds,
          cfg
        );
        const csrfToken = setAdminSessionCookies(res, cookieJwt, cfg);
        await withPlatformAdmin(async (tx) => {
          await recordPlatformAudit(tx, {
            operator: verified.operator,
            role: verified.role,
            action: "admin.session.step_up",
            targetType: "admin_session",
            targetId: verified.operator,
            reason: "OIDC MFA step-up verified via IdP auth_time",
            details: { authMethod: "oidc", authTime: verified.stepUpAt, windowSeconds: cfg.adminStepUpWindowSeconds },
            requestId,
            stepUpVerified: true
          });
        });
        res.status(200).json({
          verified: true,
          authMethod: "oidc",
          csrfToken,
          operator: verified.operator,
          stepUpAt: verified.stepUpAt,
          stepUpExpiresAt: verified.stepUpAt ? new Date((verified.stepUpAt + cfg.adminStepUpWindowSeconds) * 1000).toISOString() : null,
          stepUpWindowSeconds: cfg.adminStepUpWindowSeconds
        });
        return;
      }

      if (!body.confirmation || body.confirmation.trim().length < 3) {
        throw new AppError("VALIDATION", "Provide 'confirmation' for local/test step-up verification.");
      }
      const upgradedToken = createSuperAdminToken({
        operator: admin.operator,
        stepUpAt: nowSec,
        mfaVerified: true
      });
      const csrfToken = setAdminSessionCookies(res, upgradedToken, cfg);
      await withPlatformAdmin(async (tx) => {
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "admin.session.step_up",
          targetType: "admin_session",
          targetId: admin.operator,
          reason: `Step-up verified (${body.confirmation!.slice(0, 40)})`,
          details: { authMethod: "dev", windowSeconds: cfg.adminStepUpWindowSeconds, mfaCodeProvided: Boolean(body.mfaCode) },
          requestId,
          stepUpVerified: true
        });
      });
      res.status(200).json({
        verified: true,
        authMethod: "dev",
        token: upgradedToken,
        csrfToken,
        operator: admin.operator,
        stepUpAt: nowSec,
        stepUpExpiresAt: new Date((nowSec + cfg.adminStepUpWindowSeconds) * 1000).toISOString(),
        stepUpWindowSeconds: cfg.adminStepUpWindowSeconds
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Server-driven navigation & permissions for Platform Admin Shell
  app.get("/api/v2/admin/me", async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      const admin = await authenticateSuperAdminRequest(req);
      const nowSec = Math.floor(Date.now() / 1000);
      const stepUpActive = Boolean(admin.stepUpAt && (nowSec - admin.stepUpAt) <= cfg.adminStepUpWindowSeconds);
      res.status(200).json({
        operator: admin.operator,
        role: admin.role,
        scope: admin.scope,
        authMethod: admin.authMethod,
        mfaVerified: admin.mfaVerified,
        stepUpVerified: stepUpActive,
        stepUpWindowSeconds: cfg.adminStepUpWindowSeconds,
        stepUpExpiresAt: admin.stepUpAt ? new Date((admin.stepUpAt + cfg.adminStepUpWindowSeconds) * 1000).toISOString() : null,
        sessionExpiresAt: admin.exp ? new Date(admin.exp * 1000).toISOString() : null,
        banner: "Platform admin: no tenant business data is shown here.",
        perimeter: "ZERO_IMPERSONATION_METADATA_ONLY",
        allowedNav: [
          "overview",
          "tenants",
          "platform_users",
          "approvals",
          "users",
          "governance",
          "entitlements",
          "operations",
          "audit",
          "evidence"
        ],
        allowedActions: [
          "admin.tenant.create",
          "admin.tenant.update",
          "admin.tenant.suspend.request",
          "admin.tenant.activate",
          "admin.tenant.offboard.request",
          "admin.sector_pack.set",
          "admin.feature_flag.set",
          "admin.entitlement.set",
          "admin.ai_quota.set",
          "admin.kill_switch.request",
          "admin.platform_user.manage",
          "admin.approval.decide",
          "admin.audit.read",
          "admin.audit.export"
        ]
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Platform Overview (system health, SLO, worker, tenant & pending approval counts)
  app.get("/api/v2/admin/overview", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
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

      const counts = await withPlatformAdmin(async (tx) => {
        const tenantsRes = await tx.q("SELECT id, state FROM tenant");
        const activeTenants = tenantsRes.rows.filter((t: any) => (t.state || "ACTIVE") === "ACTIVE").length;
        const suspendedTenants = tenantsRes.rows.filter((t: any) => t.state === "SUSPENDED").length;
        const auditRes = await tx.q("SELECT id FROM platform_audit_event");
        const approvalsRes = await tx.q("SELECT id, status FROM admin_approval_request");
        const pendingApprovals = approvalsRes.rows.filter((a: any) => a.status === "PENDING").length;
        return {
          totalTenants: tenantsRes.rows.length,
          activeTenants,
          suspendedTenants,
          platformAuditCount: auditRes.rows.length,
          pendingApprovals
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
        sloEvidenceState: pgOk ? "MEASURED" : "ASSUMPTION",
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
      await authenticateSuperAdminRequest(req);
      const items = await withPlatformAdmin(async (tx) => {
        const tRes = await tx.q("SELECT id, name, region, jurisdiction_config_ref, state, version, offboard_requested_at, offboard_reason, created_at FROM tenant");
        const secRes = await tx.q("SELECT tenant_id, sector_key, pack_key, updated_at FROM tenant_sector_setting");
        const secByTenant = new Map(secRes.rows.map((s: any) => [s.tenant_id, s]));
        return tRes.rows.map((t: any) => {
          const sec: any = secByTenant.get(t.id);
          return {
            id: t.id,
            name: t.name,
            region: t.region,
            state: t.state || "ACTIVE",
            version: Number(t.version || 1),
            jurisdictionConfigRef: t.jurisdiction_config_ref ?? null,
            sectorKey: sec?.sector_key || "LEGAL",
            packKey: sec?.pack_key || getSectorMapping("LEGAL")?.packKey || "generic",
            offboardRequestedAt: t.offboard_requested_at ?? null,
            offboardReason: t.offboard_reason ?? null,
            createdAt: t.created_at
          };
        });
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Get single tenant metadata (returns ETag version for optimistic concurrency)
  app.get("/api/v2/admin/tenants/:tenantId", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const item = await withPlatformAdmin(async (tx) => {
        const tRes = await tx.q(
          "SELECT id, name, region, jurisdiction_config_ref, state, version, offboard_requested_at, offboard_reason, created_at FROM tenant WHERE id = $1",
          [tenantId]
        );
        if (!tRes.rowCount || tRes.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
        const t = tRes.rows[0];
        const secRes = await tx.q("SELECT tenant_id, sector_key, pack_key, updated_at FROM tenant_sector_setting WHERE tenant_id = $1", [tenantId]);
        const sec = secRes.rows[0];
        return {
          id: t.id,
          name: t.name,
          region: t.region,
          state: t.state || "ACTIVE",
          version: Number(t.version || 1),
          jurisdictionConfigRef: t.jurisdiction_config_ref ?? null,
          sectorKey: sec?.sector_key || "LEGAL",
          packKey: sec?.pack_key || getSectorMapping("LEGAL")?.packKey || "generic",
          offboardRequestedAt: t.offboard_requested_at ?? null,
          offboardReason: t.offboard_reason ?? null,
          createdAt: t.created_at
        };
      });
      res.setHeader("ETag", `"${item.version}"`);
      res.status(200).json(item);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Create new tenant + root organization + initial LAUNCHED/BASELINE sector pack setting
  app.post("/api/v2/admin/tenants", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const body = CreateTenantBody.parse(req.body);
      const pack = assertEnableableSectorPack(body.sectorKey);
      const requestId = String(res.locals.requestId || "");

      const tenantId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      const created = await withPlatformAdmin(async (tx) => {
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
          reason: body.reason,
          details: { name: body.name, region: body.region, sectorKey: pack.sector, rootOrganizationId: orgId },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });
        return {
          id: tenantId,
          name: body.name,
          region: body.region,
          state: "ACTIVE",
          version: 1,
          jurisdictionConfigRef: body.jurisdictionConfigRef ?? null,
          sectorKey: pack.sector,
          packKey: pack.packKey,
          rootOrganizationId: orgId
        };
      });

      res.setHeader("ETag", `"1"`);
      res.status(201).json(created);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Update tenant metadata (optimistic If-Match + mandatory reason)
  app.patch("/api/v2/admin/tenants/:tenantId", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const body = UpdateTenantBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");
      const updated = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT id, version FROM tenant WHERE id = $1`, [tenantId]);
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
        const curVersion = Number(cur.rows[0].version || 1);
        assertVersionMatch(req, curVersion, "tenant");

        await tx.q(
          `UPDATE tenant SET name = $1, region = $2, jurisdiction_config_ref = $3, version = version + 1 WHERE id = $4`,
          [body.name, body.region, body.jurisdictionConfigRef ?? null, tenantId]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "tenant.update",
          targetType: "tenant",
          targetId: tenantId,
          reason: body.reason,
          details: { name: body.name, region: body.region, jurisdictionConfigRef: body.jurisdictionConfigRef ?? null },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });
        return { id: tenantId, name: body.name, region: body.region, jurisdictionConfigRef: body.jurisdictionConfigRef ?? null, version: curVersion + 1 };
      });
      res.setHeader("ETag", `"${updated.version}"`);
      res.status(200).json(updated);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Activate or Suspend tenant (requires step-up; suspension requires four-eyes approval -> 202)
  app.post("/api/v2/admin/tenants/:tenantId/state", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const body = TenantStateBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const out = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT id, state, version FROM tenant WHERE id = $1`, [tenantId]);
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
        const curVersion = Number(cur.rows[0].version || 1);
        assertVersionMatch(req, curVersion, "tenant");

        if (body.state === "SUSPENDED") {
          const approvalRequest = await createFourEyesRequest(tx, {
            admin,
            actionType: "tenant.suspend",
            targetType: "tenant",
            targetId: tenantId,
            payload: { state: "SUSPENDED" },
            reason: body.reason,
            requestId
          });
          return { statusCode: 202, body: { status: "PENDING_APPROVAL", approvalRequest } };
        }

        await tx.q(`UPDATE tenant SET state = $1, version = version + 1 WHERE id = $2`, ["ACTIVE", tenantId]);
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "tenant.activate",
          targetType: "tenant",
          targetId: tenantId,
          reason: body.reason,
          details: { state: "ACTIVE" },
          requestId,
          stepUpVerified: true
        });
        return { statusCode: 200, body: { id: tenantId, state: "ACTIVE", version: curVersion + 1 }, etag: `"${curVersion + 1}"` };
      });

      if (out.etag) res.setHeader("ETag", out.etag);
      res.status(out.statusCode).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Offboard tenant request (no instant hard delete; routes through retention/legal holds/tombstones + four-eyes)
  app.post("/api/v2/admin/tenants/:tenantId/offboard-request", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const body = OffboardTenantBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const approvalRequest = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT id, version FROM tenant WHERE id = $1`, [tenantId]);
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
        assertVersionMatch(req, Number(cur.rows[0].version || 1), "tenant");
        return createFourEyesRequest(tx, {
          admin,
          actionType: "tenant.offboard.request",
          targetType: "tenant",
          targetId: tenantId,
          payload: { workflow: "RETENTION_LEGAL_HOLD_TOMBSTONE" },
          reason: body.reason,
          requestId
        });
      });

      res.status(202).json({
        status: "PENDING_APPROVAL",
        note: "Offboarding never hard-deletes immediately; upon four-eyes approval it enters the retention, legal-hold, and tombstone workflow.",
        approvalRequest
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Set tenant sector pack (strict body, mandatory reason, blocks preview packs, step-up + four-eyes to enable launched pack)
  app.put("/api/v2/admin/tenants/:tenantId/sector-pack", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const body = SetSectorPackBody.parse(req.body);
      const pack = assertEnableableSectorPack(body.sectorKey);
      const requestId = String(res.locals.requestId || "");

      const out = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT id, version FROM tenant WHERE id = $1`, [tenantId]);
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
        assertVersionMatch(req, Number(cur.rows[0].version || 1), "tenant");

        if (pack.status === "LAUNCHED") {
          const approvalRequest = await createFourEyesRequest(tx, {
            admin,
            actionType: "sector_pack.enable",
            targetType: "tenant",
            targetId: tenantId,
            payload: { sectorKey: pack.sector, packKey: pack.packKey },
            reason: body.reason,
            requestId
          });
          return { statusCode: 202, body: { status: "PENDING_APPROVAL", approvalRequest } };
        }

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
          reason: body.reason,
          details: { sectorKey: pack.sector, packKey: pack.packKey },
          requestId,
          stepUpVerified: true
        });
        return { statusCode: 200, body: { tenantId, sectorKey: pack.sector, packKey: pack.packKey } };
      });

      res.status(out.statusCode).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // List principals & memberships for a tenant: DPO-safe pseudonymous IDs + masked identifiers ONLY + EVERY VIEW AUDITED
  app.get("/api/v2/admin/tenants/:tenantId/principals", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const requestId = String(res.locals.requestId || "");

      const data = await withPlatformAdmin(async (tx) => {
        const pRes = await tx.q(`SELECT id, tenant_id, external_subject, kind, active, version FROM principal WHERE tenant_id = $1`, [tenantId]);
        const mRes = await tx.q(`SELECT id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, version FROM effective_membership WHERE tenant_id = $1`, [tenantId]);
        const pMap = new Map(pRes.rows.map((p: any) => [p.id, p]));

        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "tenant.principals.viewed",
          targetType: "tenant",
          targetId: tenantId,
          reason: "Pseudonymous tenant access review",
          details: { returnedMemberships: mRes.rows.length },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });

        return mRes.rows.map((m: any) => {
          const p: any = pMap.get(m.principal_id);
          return {
            membershipId: m.id,
            principalId: m.principal_id,
            pseudonymousId: pseudonymizePrincipalRef(String(m.principal_id), tenantId),
            maskedSubject: maskSubjectIdentifier(p?.external_subject || ""),
            kind: p?.kind || "USER",
            domainRole: m.domain_role,
            organizationId: m.organization_id,
            validFrom: m.valid_from,
            validTo: m.valid_to ?? null,
            version: Number(m.version || 1),
            principalActive: p?.active !== false,
            active: p?.active !== false && (!m.valid_to || new Date(m.valid_to).getTime() > Date.now())
          };
        });
      });
      res.status(200).json({ tenantId, privacyMode: "PSEUDONYMOUS_MASKED_AUDITED", items: data });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Bootstrap Tenant Admin (EMPLOYER_ADMIN ONLY) — STRICTLY refuses approval roles & self-assignment
  app.post("/api/v2/admin/tenants/:tenantId/memberships", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const body = AssignMembershipBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      if (body.domainRole !== "EMPLOYER_ADMIN") {
        throw new AppError(
          "FORBIDDEN",
          `Separation rule violation: Platform Super Admin cannot grant '${body.domainRole}'. Only initial tenant admin ('EMPLOYER_ADMIN') bootstrap is permitted; workflow and approval roles are managed exclusively by Tenant Admin.`
        );
      }

      if (body.externalSubject.toLowerCase() === admin.operator.toLowerCase()) {
        throw new AppError(
          "FORBIDDEN",
          "Separation rule violation: a platform admin cannot grant themselves a tenant membership."
        );
      }

      const created = await withPlatformAdmin(async (tx) => {
        const staffCheck = await tx.q(`SELECT id FROM platform_user WHERE subject = $1`, [body.externalSubject]);
        if ((staffCheck.rowCount ?? 0) > 0) {
          throw new AppError(
            "FORBIDDEN",
            "Separation rule violation: platform staff accounts cannot hold tenant memberships."
          );
        }

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
          [membershipId, tenantId, principal.id, orgId, "EMPLOYER_ADMIN", validFrom]
        );

        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "membership.bootstrap_tenant_admin",
          targetType: "effective_membership",
          targetId: membershipId,
          reason: body.reason,
          details: {
            tenantId,
            pseudonymousId: pseudonymizePrincipalRef(principal.id, tenantId),
            maskedSubject: maskSubjectIdentifier(body.externalSubject),
            domainRole: "EMPLOYER_ADMIN",
            organizationId: orgId
          },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });

        return {
          membershipId,
          principalId: principal.id,
          pseudonymousId: pseudonymizePrincipalRef(principal.id, tenantId),
          maskedSubject: maskSubjectIdentifier(body.externalSubject),
          kind: principal.kind,
          domainRole: "EMPLOYER_ADMIN",
          organizationId: orgId,
          validFrom,
          validTo: null,
          version: 1,
          active: true
        };
      });

      res.setHeader("ETag", `"1"`);
      res.status(201).json(created);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Revoke membership (strict body, mandatory reason, tenant-scoped UPDATE, If-Match support)
  app.post("/api/v2/admin/tenants/:tenantId/memberships/:membershipId/revoke", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const tenantId = String(req.params.tenantId);
      const membershipId = String(req.params.membershipId);
      assertValidUuidParam(tenantId, "Tenant");
      assertValidUuidParam(membershipId, "Membership");
      const body = RevokeMembershipBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(
          `SELECT id, tenant_id, version FROM effective_membership WHERE tenant_id = $1`,
          [tenantId]
        );
        const match = cur.rows.find((m: any) => m.id === membershipId);
        if (!match) {
          throw new AppError("NOT_FOUND", "Membership not found.");
        }
        assertVersionMatch(req, Number(match.version || 1), "effective_membership");

        const upd = await tx.q(
          `UPDATE effective_membership SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond'), version = version + 1 WHERE id = $1 AND tenant_id = $2`,
          [membershipId, tenantId]
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
          reason: body.reason,
          details: { tenantId, membershipId },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });
      });
      res.status(200).json({ membershipId, revoked: true });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Platform Staff Accounts (Named individuals only; four-eyes on creating/promoting/disabling SUPER_ADMIN)
  app.get("/api/v2/admin/platform-users", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const items = await withPlatformAdmin(async (tx) => {
        const r = await tx.q(
          `SELECT id, subject, display_name, platform_role, status, break_glass, mfa_enforced, created_at, updated_at, version FROM platform_user`
        );
        return r.rows.map((u: any) => ({
          id: u.id,
          subject: u.subject,
          displayName: u.display_name,
          platformRole: u.platform_role,
          status: u.status,
          breakGlass: Boolean(u.break_glass),
          mfaEnforced: u.mfa_enforced !== false,
          createdAt: u.created_at,
          updatedAt: u.updated_at,
          version: Number(u.version || 1)
        }));
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/admin/platform-users", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const body = PlatformUserCreateBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      if (!body.breakGlass && SHARED_ACCOUNT_RE.test(body.subject)) {
        throw new AppError(
          "VALIDATION",
          "Shared or generic platform account names are refused. Use a named individual identity (or mark explicit breakGlass)."
        );
      }

      const newId = crypto.randomUUID();
      const out = await withPlatformAdmin(async (tx) => {
        const dup = await tx.q(`SELECT id FROM platform_user WHERE subject = $1`, [body.subject]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new AppError("CONFLICT", `Platform user '${body.subject}' already exists.`);
        }

        if (body.platformRole === "SUPER_ADMIN" || body.breakGlass) {
          const approvalRequest = await createFourEyesRequest(tx, {
            admin,
            actionType: "platform_user.create",
            targetType: "platform_user",
            targetId: newId,
            payload: {
              id: newId,
              subject: body.subject,
              displayName: body.displayName,
              platformRole: body.platformRole,
              breakGlass: body.breakGlass
            },
            reason: body.reason,
            requestId
          });
          return { statusCode: 202, body: { status: "PENDING_APPROVAL", approvalRequest } };
        }

        await tx.q(
          `INSERT INTO platform_user (id, subject, display_name, platform_role, break_glass) VALUES ($1, $2, $3, $4, $5)`,
          [newId, body.subject, body.displayName, body.platformRole, false]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "platform_user.create",
          targetType: "platform_user",
          targetId: newId,
          reason: body.reason,
          details: { subject: body.subject, platformRole: body.platformRole, breakGlass: false },
          requestId,
          stepUpVerified: true
        });
        return {
          statusCode: 201,
          body: {
            id: newId,
            subject: body.subject,
            displayName: body.displayName,
            platformRole: body.platformRole,
            status: "ACTIVE",
            breakGlass: false,
            mfaEnforced: true,
            version: 1
          }
        };
      });

      res.status(out.statusCode).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.patch("/api/v2/admin/platform-users/:userId/role", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const userId = String(req.params.userId);
      assertValidUuidParam(userId, "Platform user");
      const body = PlatformUserRoleBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const out = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT id, subject, platform_role, status, break_glass, version FROM platform_user WHERE id = $1`, [userId]);
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Platform user not found.");
        const user = cur.rows[0];
        assertVersionMatch(req, Number(user.version || 1), "platform_user");

        if (user.platform_role === "SUPER_ADMIN" && body.platformRole !== "SUPER_ADMIN" && user.status === "ACTIVE" && !user.break_glass) {
          const allPu = await tx.q(`SELECT id, platform_role, status, break_glass FROM platform_user`);
          const activeNamedSuperAdmins = allPu.rows.filter(
            (r: any) => r.platform_role === "SUPER_ADMIN" && r.status === "ACTIVE" && !r.break_glass
          );
          if (activeNamedSuperAdmins.length <= 2) {
            throw new AppError(
              "CONFLICT",
              "Four-eyes deadlock guard: at least two active named SUPER_ADMIN accounts must remain before demoting another SUPER_ADMIN."
            );
          }
        }

        if (body.platformRole === "SUPER_ADMIN") {
          const approvalRequest = await createFourEyesRequest(tx, {
            admin,
            actionType: "platform_user.role.change",
            targetType: "platform_user",
            targetId: userId,
            payload: { platformRole: body.platformRole },
            reason: body.reason,
            requestId
          });
          return { statusCode: 202, body: { status: "PENDING_APPROVAL", approvalRequest } };
        }

        await tx.q(`UPDATE platform_user SET platform_role = $1, updated_at = now(), version = version + 1 WHERE id = $2`, [body.platformRole, userId]);
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "platform_user.role.change",
          targetType: "platform_user",
          targetId: userId,
          reason: body.reason,
          details: { from: user.platform_role, to: body.platformRole },
          requestId,
          stepUpVerified: true
        });
        return { statusCode: 200, body: { id: userId, platformRole: body.platformRole, version: Number(user.version || 1) + 1 } };
      });

      res.status(out.statusCode).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/admin/platform-users/:userId/disable", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const userId = String(req.params.userId);
      assertValidUuidParam(userId, "Platform user");
      const body = PlatformUserDisableBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const out = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT id, subject, platform_role, status, break_glass, version FROM platform_user WHERE id = $1`, [userId]);
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Platform user not found.");
        const user = cur.rows[0];
        if (String(user.subject).toLowerCase() === admin.operator.toLowerCase()) {
          throw new AppError("CONFLICT", "Cannot disable your own active Super Admin account.");
        }
        assertVersionMatch(req, Number(user.version || 1), "platform_user");

        if (user.platform_role === "SUPER_ADMIN" && user.status === "ACTIVE" && !user.break_glass) {
          const allPu = await tx.q(`SELECT id, platform_role, status, break_glass FROM platform_user`);
          const activeNamedSuperAdmins = allPu.rows.filter(
            (r: any) => r.platform_role === "SUPER_ADMIN" && r.status === "ACTIVE" && !r.break_glass
          );
          if (activeNamedSuperAdmins.length <= 2) {
            throw new AppError(
              "CONFLICT",
              "Four-eyes deadlock guard: at least two active named SUPER_ADMIN accounts must remain before disabling another SUPER_ADMIN."
            );
          }
        }

        if (user.platform_role === "SUPER_ADMIN") {
          const approvalRequest = await createFourEyesRequest(tx, {
            admin,
            actionType: "platform_user.disable",
            targetType: "platform_user",
            targetId: userId,
            payload: { status: "DISABLED" },
            reason: body.reason,
            requestId
          });
          return { statusCode: 202, body: { status: "PENDING_APPROVAL", approvalRequest } };
        }

        await tx.q(`UPDATE platform_user SET status = $1, updated_at = now(), version = version + 1 WHERE id = $2`, ["DISABLED", userId]);
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "platform_user.disable",
          targetType: "platform_user",
          targetId: userId,
          reason: body.reason,
          details: { subject: user.subject, status: "DISABLED" },
          requestId,
          stepUpVerified: true
        });
        return { statusCode: 200, body: { id: userId, status: "DISABLED", version: Number(user.version || 1) + 1 } };
      });

      res.status(out.statusCode).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Four-Eyes Approval Queue
  app.get("/api/v2/admin/approvals", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const statusFilter = typeof req.query.status === "string" ? req.query.status.toUpperCase() : null;
      const items = await withPlatformAdmin(async (tx) => {
        const r = await tx.q(
          `SELECT id, action_type, target_type, target_id, payload, reason, requested_by, requested_at, status, approved_by, approved_at, decision_reason, executed_at, expires_at, request_id, version
           FROM admin_approval_request
           ORDER BY requested_at DESC`
        );
        return r.rows
          .filter((a: any) => !statusFilter || a.status === statusFilter)
          .map((a: any) => ({
            id: a.id,
            actionType: a.action_type,
            targetType: a.target_type,
            targetId: a.target_id,
            payload: a.payload,
            reason: a.reason,
            requestedBy: a.requested_by,
            requestedAt: a.requested_at,
            status: a.status,
            approvedBy: a.approved_by ?? null,
            approvedAt: a.approved_at ?? null,
            decisionReason: a.decision_reason ?? null,
            executedAt: a.executed_at ?? null,
            expiresAt: a.expires_at,
            requestId: a.request_id ?? null,
            version: Number(a.version || 1)
          }));
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/admin/approvals/:id/approve", async (req: Request, res: Response) => {
    try {
      const approver = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(approver);
      const id = String(req.params.id);
      assertValidUuidParam(id, "Approval request");
      const body = ApprovalDecisionBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const out = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(
          `SELECT id, action_type, target_type, target_id, payload, reason, requested_by, status, expires_at, version FROM admin_approval_request WHERE id = $1`,
          [id]
        );
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Approval request not found.");
        const reqRow = cur.rows[0];
        assertVersionMatch(req, Number(reqRow.version || 1), "admin_approval_request");

        if (String(reqRow.requested_by).toLowerCase() === approver.operator.toLowerCase()) {
          throw new AppError("FORBIDDEN", "Four-eyes violation: self-approval is strictly refused. A second distinct Super Admin must approve.");
        }
        if (reqRow.status !== "PENDING") {
          throw new AppError("CONFLICT", `Approval request is already '${reqRow.status}' (replayed approval refused).`);
        }
        if (new Date(reqRow.expires_at).getTime() <= Date.now()) {
          await tx.q(`UPDATE admin_approval_request SET status = $1, approved_by = $2, decision_reason = $3, version = version + 1 WHERE id = $4`, [
            "EXPIRED",
            null,
            "Expired prior to approval",
            id
          ]);
          throw new AppError("CONFLICT", "Approval request has expired. Submit a fresh request.");
        }

        const result = await executeApprovedAction(tx, reqRow, approver, body.reason, requestId);
        await tx.q(
          `UPDATE admin_approval_request SET status = $1, approved_by = $2, decision_reason = $3, approved_at = now(), executed_at = now(), version = version + 1 WHERE id = $4`,
          ["EXECUTED", approver.operator, body.reason, id]
        );
        return {
          id,
          status: "EXECUTED",
          requestedBy: reqRow.requested_by,
          approvedBy: approver.operator,
          result
        };
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/admin/approvals/:id/reject", async (req: Request, res: Response) => {
    try {
      const approver = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(approver);
      const id = String(req.params.id);
      assertValidUuidParam(id, "Approval request");
      const body = ApprovalDecisionBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const out = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(
          `SELECT id, action_type, target_type, target_id, requested_by, status, version FROM admin_approval_request WHERE id = $1`,
          [id]
        );
        if (!cur.rowCount || cur.rowCount === 0) throw new AppError("NOT_FOUND", "Approval request not found.");
        const reqRow = cur.rows[0];
        assertVersionMatch(req, Number(reqRow.version || 1), "admin_approval_request");
        if (String(reqRow.requested_by).toLowerCase() === approver.operator.toLowerCase()) {
          throw new AppError("FORBIDDEN", "Four-eyes violation: requester cannot decide their own approval request.");
        }
        if (reqRow.status !== "PENDING") {
          throw new AppError("CONFLICT", `Approval request is already '${reqRow.status}'.`);
        }

        await tx.q(
          `UPDATE admin_approval_request SET status = $1, approved_by = $2, decision_reason = $3, approved_at = now(), version = version + 1 WHERE id = $4`,
          ["REJECTED", approver.operator, body.reason, id]
        );
        await recordPlatformAudit(tx, {
          operator: reqRow.requested_by,
          role: "SUPER_ADMIN",
          action: `approval.rejected:${reqRow.action_type}`,
          targetType: reqRow.target_type,
          targetId: reqRow.target_id,
          reason: body.reason,
          details: { approvalRequestId: id },
          requestId,
          approver: approver.operator,
          stepUpVerified: true
        });
        return { id, status: "REJECTED", rejectedBy: approver.operator };
      });

      res.status(200).json(out);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Governance: Sector packs & jurisdiction registry (explicitly flags preview packs as not enabled)
  app.get("/api/v2/admin/governance", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const packs = listAvailableSectors();
      res.status(200).json({
        sectorPacks: packs.map((p) => {
          const full = getSectorMapping(p.sectorKey);
          const enableable = p.status === "BASELINE" || p.status === "LAUNCHED";
          return {
            sectorKey: p.sectorKey,
            packKey: p.packKey,
            displayName: p.displayName,
            status: p.status,
            enableable,
            statusLabel: enableable ? (p.status === "BASELINE" ? "baseline core" : "launched") : "preview, not enabled",
            version: "v1.0",
            reviewStatus: p.status === "LAUNCHED" ? "LEGAL_ACTIVE_PILOT_SCOPE" : p.status === "BASELINE" ? "NEUTRAL_CORE" : "PREVIEW_NOT_ENABLED",
            permittedClaims: full?.claimScope ?? [],
            restrictions: full?.cannotOverride ?? []
          };
        })
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Feature flags list & toggle (reason required; enabling requires step-up + four-eyes -> 202)
  app.get("/api/v2/admin/feature-flags", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const items = await withPlatformAdmin(async (tx) => {
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
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const body = FeatureFlagBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");
      const targetId = `${body.tenantId ?? "global"}:${body.flag}`;

      const out = await withPlatformAdmin(async (tx) => {
        if (body.enabled) {
          const approvalRequest = await createFourEyesRequest(tx, {
            admin,
            actionType: "feature_flag.enable",
            targetType: "feature_flag",
            targetId,
            payload: { tenantId: body.tenantId, flag: body.flag, enabled: true },
            reason: body.reason,
            requestId
          });
          return { statusCode: 202, body: { status: "PENDING_APPROVAL", approvalRequest } };
        }

        const changedAt = new Date().toISOString();
        await tx.q(
          `INSERT INTO feature_flag (tenant_id, flag, enabled, changed_by, changed_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
          [body.tenantId, body.flag, false, admin.operator, changedAt]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "feature_flag.set",
          targetType: "feature_flag",
          targetId,
          reason: body.reason,
          details: { tenantId: body.tenantId, flag: body.flag, enabled: false },
          requestId,
          stepUpVerified: true
        });
        return { statusCode: 200, body: { tenantId: body.tenantId, flag: body.flag, enabled: false } };
      });

      res.status(out.statusCode).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Commercial Entitlements per tenant (Entitlement AND Policy; zero privacy inputs)
  app.get("/api/v2/admin/entitlements", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId.trim() ? req.query.tenantId.trim() : null;
      if (tenantId) assertValidUuidParam(tenantId, "Tenant");
      const items = await withPlatformAdmin(async (tx) => {
        const r = tenantId
          ? await tx.q(`SELECT tenant_id, feature_key, enabled, notes, updated_by, updated_at, version FROM tenant_entitlement WHERE tenant_id = $1`, [tenantId])
          : await tx.q(`SELECT tenant_id, feature_key, enabled, notes, updated_by, updated_at, version FROM tenant_entitlement`);
        return r.rows.map((e: any) => ({
          tenantId: e.tenant_id,
          featureKey: e.feature_key,
          enabled: Boolean(e.enabled),
          notes: e.notes ?? null,
          updatedBy: e.updated_by ?? null,
          updatedAt: e.updated_at,
          version: Number(e.version || 1)
        }));
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.post("/api/v2/admin/entitlements", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const body = EntitlementBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");
      if (PRIVACY_OVERRIDE_KEY_RE.test(body.featureKey)) {
        throw new AppError("FORBIDDEN", "Entitlements can never modify or weaken the privacy floor or enable individual tracking.");
      }

      const saved = await withPlatformAdmin(async (tx) => {
        const cur = await tx.q(`SELECT tenant_id, feature_key, version FROM tenant_entitlement WHERE tenant_id = $1`, [body.tenantId]);
        const existing = cur.rows.find((r: any) => r.feature_key === body.featureKey);
        if (existing) {
          assertVersionMatch(req, Number(existing.version || 1), "tenant_entitlement");
        }
        await tx.q(
          `INSERT INTO tenant_entitlement (tenant_id, feature_key, enabled, notes, updated_by, updated_at, version)
           VALUES ($1, $2, $3, $4, $5, now(), 1)
           ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now(), version = tenant_entitlement.version + 1`,
          [body.tenantId, body.featureKey, body.enabled, body.notes ?? null, admin.operator]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "entitlement.set",
          targetType: "tenant_entitlement",
          targetId: `${body.tenantId}:${body.featureKey}`,
          reason: body.reason,
          details: { tenantId: body.tenantId, featureKey: body.featureKey, enabled: body.enabled },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });
        return {
          tenantId: body.tenantId,
          featureKey: body.featureKey,
          enabled: body.enabled,
          notes: body.notes ?? null,
          version: existing ? Number(existing.version || 1) + 1 : 1
        };
      });

      res.setHeader("ETag", `"${saved.version}"`);
      res.status(200).json(saved);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Per-tenant AI Quota Configuration (platform metadata only)
  app.get("/api/v2/admin/ai-quota", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const items = await withPlatformAdmin(async (tx) => {
        const tRes = await tx.q(`SELECT id, name, state FROM tenant`);
        const qRes = await tx.q(`SELECT tenant_id, monthly_budget_minor, updated_by, updated_at, version FROM tenant_ai_quota_config`);
        const qMap = new Map(qRes.rows.map((r: any) => [r.tenant_id, r]));
        return tRes.rows.map((t: any) => {
          const q: any = qMap.get(t.id);
          return {
            tenantId: t.id,
            tenantName: t.name,
            tenantState: t.state || "ACTIVE",
            monthlyBudgetMinor: Number(q?.monthly_budget_minor ?? 50000),
            updatedBy: q?.updated_by ?? null,
            updatedAt: q?.updated_at ?? null,
            version: Number(q?.version || 1)
          };
        });
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.put("/api/v2/admin/tenants/:tenantId/ai-quota", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const tenantId = String(req.params.tenantId);
      assertValidUuidParam(tenantId, "Tenant");
      const body = AiQuotaConfigBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const saved = await withPlatformAdmin(async (tx) => {
        const tCur = await tx.q(`SELECT id FROM tenant WHERE id = $1`, [tenantId]);
        if (!tCur.rowCount || tCur.rowCount === 0) throw new AppError("NOT_FOUND", "Tenant not found.");
        const qCur = await tx.q(`SELECT tenant_id, version FROM tenant_ai_quota_config WHERE tenant_id = $1`, [tenantId]);
        const curVer = Number(qCur.rows[0]?.version || 1);
        if ((qCur.rowCount ?? 0) > 0) {
          assertVersionMatch(req, curVer, "tenant_ai_quota_config");
        }
        await tx.q(
          `INSERT INTO tenant_ai_quota_config (tenant_id, monthly_budget_minor, updated_by, updated_at, version)
           VALUES ($1, $2, $3, now(), 1)
           ON CONFLICT (tenant_id) DO UPDATE SET monthly_budget_minor = EXCLUDED.monthly_budget_minor, updated_by = EXCLUDED.updated_by, updated_at = now(), version = tenant_ai_quota_config.version + 1`,
          [tenantId, body.monthlyBudgetMinor, admin.operator]
        );
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "ai_quota.set",
          targetType: "tenant_ai_quota_config",
          targetId: tenantId,
          reason: body.reason,
          details: { monthlyBudgetMinor: body.monthlyBudgetMinor },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });
        return { tenantId, monthlyBudgetMinor: body.monthlyBudgetMinor, version: (qCur.rowCount ?? 0) > 0 ? curVer + 1 : 1 };
      });

      res.setHeader("ETag", `"${saved.version}"`);
      res.status(200).json(saved);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Governed Kill Switches via Super Admin (requires step-up + four-eyes approval -> 202)
  app.post("/api/v2/admin/kill-switches", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      assertStepUpRecent(admin);
      const body = AdminKillSwitchBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const approvalRequest = await withPlatformAdmin(async (tx) =>
        createFourEyesRequest(tx, {
          admin,
          actionType: "ai.kill_switch.set",
          targetType: "ai_kill_switch",
          targetId: body.scope,
          payload: { scope: body.scope, active: body.active, expiresAt: body.expiresAt ?? null },
          reason: body.reason,
          requestId
        })
      );

      res.status(202).json({ status: "PENDING_APPROVAL", approvalRequest });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Content-free Operational Summary (worker heartbeat, queue depth, dead letters, connector freshness)
  app.get("/api/v2/admin/operations", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const workerMetrics = getWorkerMetrics();
      const connectors = await withPlatformAdmin(async (tx) => {
        const r = await tx.q(`SELECT id, source, state, last_success_at, expected_cadence_seconds FROM ops_connector_health`);
        return r.rows.map((c: any) => {
          const last = c.last_success_at ? new Date(c.last_success_at).getTime() : null;
          const cadence = Number(c.expected_cadence_seconds || 3600);
          const lagSec = last ? (Date.now() - last) / 1000 : Infinity;
          const health = !last ? "NEVER_SYNCED" : lagSec > cadence * 3 ? "STALE" : lagSec > cadence * 1.5 ? "DELAYED" : "FRESH";
          return { id: c.id, source: c.source, state: c.state, health, lastSuccessAt: c.last_success_at ?? null };
        });
      });
      const workerStats = await withWorker(async (tx) => {
        const pendingRes = await tx.q(`SELECT count(*)::int AS count FROM outbox_event WHERE published_at IS NULL AND state IN ('PENDING','PROCESSING')`);
        const dlRes = await tx.q(`SELECT count(*)::int AS count FROM dead_letter_event WHERE replayed_at IS NULL`);
        return {
          queueDepth: Number(pendingRes.rows[0]?.count ?? 0),
          deadLetterCount: Number(dlRes.rows[0]?.count ?? 0)
        };
      });
      res.status(200).json({
        worker: {
          workerId: workerMetrics.workerId,
          state: workerMetrics.state,
          heartbeatAt: workerMetrics.heartbeatAt,
          queueLagMs: workerMetrics.queueLagMs,
          totalProcessed: workerMetrics.totalProcessed,
          totalFailures: workerMetrics.totalFailures
        },
        ...workerStats,
        connectors
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Immutable platform audit log (with search & filter)
  app.get("/api/v2/admin/audit", async (req: Request, res: Response) => {
    try {
      await authenticateSuperAdminRequest(req);
      const operatorFilter = typeof req.query.operator === "string" ? req.query.operator.trim().toLowerCase() : "";
      const actionFilter = typeof req.query.action === "string" ? req.query.action.trim().toLowerCase() : "";
      const targetTypeFilter = typeof req.query.targetType === "string" ? req.query.targetType.trim().toLowerCase() : "";
      const searchQ = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const limit = parseLimit(req, 100, 500);

      const items = await withPlatformAdmin(async (tx) => {
        const r = await tx.q(
          `SELECT id, occurred_at, operator, role, action, target_type, target_id, reason, details, request_id, approver, step_up_verified
           FROM platform_audit_event
           ORDER BY occurred_at DESC
           LIMIT 500`
        );
        return r.rows
          .filter((row: any) => {
            if (operatorFilter && !String(row.operator || "").toLowerCase().includes(operatorFilter)) return false;
            if (actionFilter && !String(row.action || "").toLowerCase().includes(actionFilter)) return false;
            if (targetTypeFilter && !String(row.target_type || "").toLowerCase().includes(targetTypeFilter)) return false;
            if (searchQ) {
              const hay = `${row.operator} ${row.action} ${row.target_type} ${row.target_id} ${row.reason || ""} ${row.approver || ""} ${row.request_id || ""}`.toLowerCase();
              if (!hay.includes(searchQ)) return false;
            }
            return true;
          })
          .slice(0, limit);
      });
      res.status(200).json({ items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Audited export of immutable platform audit log (export itself is recorded in platform_audit_event)
  app.post("/api/v2/admin/audit/export", async (req: Request, res: Response) => {
    try {
      const admin = await authenticateSuperAdminRequest(req);
      const body = AuditExportBody.parse(req.body);
      const requestId = String(res.locals.requestId || "");

      const items = await withPlatformAdmin(async (tx) => {
        const r = await tx.q(
          `SELECT id, occurred_at, operator, role, action, target_type, target_id, reason, details, request_id, approver, step_up_verified
           FROM platform_audit_event
           ORDER BY occurred_at DESC
           LIMIT 500`
        );
        const filtered = r.rows.filter((row: any) => {
          if (body.operator && !String(row.operator || "").toLowerCase().includes(body.operator.toLowerCase())) return false;
          if (body.action && !String(row.action || "").toLowerCase().includes(body.action.toLowerCase())) return false;
          if (body.targetType && !String(row.target_type || "").toLowerCase().includes(body.targetType.toLowerCase())) return false;
          return true;
        });
        await recordPlatformAudit(tx, {
          operator: admin.operator,
          role: admin.role,
          action: "platform_audit.export",
          targetType: "platform_audit_event",
          targetId: `export:${body.format}`,
          reason: body.reason,
          details: { format: body.format, exportedCount: filtered.length },
          requestId,
          stepUpVerified: Boolean(admin.stepUpAt)
        });
        return filtered;
      });

      if (body.format === "csv") {
        const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const header = "id,occurred_at,operator,approver,role,action,target_type,target_id,reason,request_id,step_up_verified";
        const lines = items.map((r: any) =>
          [r.id, r.occurred_at, r.operator, r.approver, r.role, r.action, r.target_type, r.target_id, r.reason, r.request_id, r.step_up_verified].map(esc).join(",")
        );
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.status(200).send([header, ...lines].join("\n"));
        return;
      }

      res.status(200).json({
        exportedAt: new Date().toISOString(),
        exportedBy: admin.operator,
        count: items.length,
        items
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });
}
