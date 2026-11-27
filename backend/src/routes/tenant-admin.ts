// backend/src/routes/tenant-admin.ts
// Tenant Admin Routes (/api/v2/tenant-admin/*)
// Strict tenant isolation under abate_app + FORCE RLS:
// - Tenant Admin (EMPLOYER_ADMIN) manages users, effective-dated role memberships, OIDC invitations,
//   organization structure, own searchable audit view, rights requests history, and unified usage.
// - Never sees foreign tenants (foreign ID and nonexistent ID return identical 404 NOT_FOUND).
// - Cannot weaken the privacy floor or enable preview sector packs.
// - Never receives control/hazard approval authority from the EMPLOYER_ADMIN role alone.

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { loadConfig } from "../platform/config";
import { toErrorResponse, AppError } from "../platform/errors";
import { runCommand, computeRequestHash } from "../platform/command";
import { authenticate, resolveActor, authorize, APPROVAL_ROLES } from "../domains/tenant/auth";
import { withTenant } from "../platform/db/with-tenant";
import { maskSubjectIdentifier } from "../domains/support";
import { getAiQuotaStatus } from "../domains/ai";
import { getDefaultEntitlements } from "../domains/lifecycle";
import { getHeader, parseLimit } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TENANT_DOMAIN_ROLES = [
  "EMPLOYER_ADMIN",
  "RISK_OWNER",
  "CONTROL_OWNER",
  "APPROVER",
  "REVIEWER",
  "IMPLEMENTATION_OWNER",
  "DPO",
  "PRIVACY_OFFICER",
  "VIEWER",
  "WORKER_REP"
] as const;

const AssignTenantMembershipBody = z.object({
  principalId: z.string().uuid().optional(),
  externalSubject: z.string().trim().min(3).max(160).optional(),
  kind: z.enum(["USER", "WORKLOAD"]).default("USER"),
  organizationId: z.string().uuid(),
  domainRole: z.enum(TENANT_DOMAIN_ROLES),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const EndMembershipBody = z.object({
  validTo: z.string().datetime().optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

const PrincipalStatusBody = z.object({
  reason: z.string().trim().min(5).max(500)
}).strict();

const CreateInvitationBody = z.object({
  email: z.string().trim().email().max(180),
  externalSubject: z.string().trim().min(3).max(160).optional(),
  organizationId: z.string().uuid(),
  domainRole: z.enum(TENANT_DOMAIN_ROLES),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().nullable().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  reason: z.string().trim().min(5).max(500)
}).strict();

const RevokeInvitationBody = z.object({
  reason: z.string().trim().min(5).max(500)
}).strict();

const UpdateOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  parentId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(5).max(500)
}).strict();

function requireIdempotencyKey(req: Request): string {
  const key = getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key");
  if (!key) {
    throw new AppError(
      "VALIDATION",
      "Header 'Idempotency-Key' is required for all state-changing commands.",
      undefined,
      undefined,
      ["Idempotency-Key"]
    );
  }
  return key;
}

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

function assertUuidOr404(val: string, label: string): void {
  if (!UUID_RE.test(val)) {
    throw new AppError("NOT_FOUND", `${label} not found.`);
  }
}

/** Ensures caller's active role (taking dev switcher role into account in local/test) satisfies the command. */
function authorizeTenantAdmin(
  actor: { principalId: string; tenantId: string; memberships: Array<{ organization_id: string; domain_role: string }> },
  command: string,
  claimedRole: string | undefined,
  purpose: string | undefined
): void {
  const cfg = loadConfig();
  const effectiveActor = claimedRole && (cfg.appEnv === "local" || cfg.appEnv === "test")
    ? {
        ...actor,
        memberships: [{ organization_id: actor.memberships[0]?.organization_id || "", domain_role: claimedRole }]
      }
    : actor;
  authorize(effectiveActor, command, { tenantId: actor.tenantId }, purpose);
}

function hashEmail(email: string): string {
  const cfg = loadConfig();
  return crypto.createHmac("sha256", cfg.pseudonymSecret).update(`invite:${email.trim().toLowerCase()}`).digest("hex");
}

export function registerTenantAdminRoutes(app: Express): void {
  // 1. List tenant users & effective-dated role memberships
  app.get("/api/v2/tenant-admin/users", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.users.read", who.role, who.purpose);

      const items = await withTenant(who.tenantId, async (tx) => {
        const pRes = await tx.q(`SELECT id, tenant_id, external_subject, kind, active, deactivated_at, version FROM principal`);
        const mRes = await tx.q(
          `SELECT id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, version FROM effective_membership`
        );
        const nowMs = Date.now();
        return pRes.rows.map((p: any) => {
          const memberships = mRes.rows
            .filter((m: any) => m.principal_id === p.id)
            .map((m: any) => {
              const fromMs = new Date(m.valid_from).getTime();
              const toMs = m.valid_to ? new Date(m.valid_to).getTime() : Infinity;
              return {
                membershipId: m.id,
                organizationId: m.organization_id,
                domainRole: m.domain_role,
                validFrom: m.valid_from,
                validTo: m.valid_to ?? null,
                version: Number(m.version || 1),
                activeNow: fromMs <= nowMs && nowMs < toMs
              };
            });
          const activeApproverRoles = memberships
            .filter((m: any) => m.activeNow && (APPROVAL_ROLES as readonly string[]).includes(m.domainRole))
            .map((m: any) => m.domainRole);
          return {
            principalId: p.id,
            externalSubject: p.external_subject,
            kind: p.kind,
            active: p.active !== false,
            deactivatedAt: p.deactivated_at ?? null,
            version: Number(p.version || 1),
            hasApprovalAuthorityNow: p.active !== false && activeApproverRoles.length > 0,
            activeApproverRoles,
            memberships
          };
        });
      });

      res.status(200).json({ tenantId: who.tenantId, items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 2. Get single tenant user (foreign tenant ID and nonexistent ID return identical 404 NOT_FOUND)
  app.get("/api/v2/tenant-admin/users/:principalId", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.users.read", who.role, who.purpose);
      const principalId = String(req.params.principalId);
      assertUuidOr404(principalId, "User");

      const item = await withTenant(who.tenantId, async (tx) => {
        const pRes = await tx.q(`SELECT id, tenant_id, external_subject, kind, active, deactivated_at, version FROM principal WHERE id = $1`, [principalId]);
        if (!pRes.rowCount || pRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", "User not found.");
        }
        const p = pRes.rows[0];
        const mRes = await tx.q(`SELECT id, principal_id, organization_id, domain_role, valid_from, valid_to, version FROM effective_membership`);
        const memberships = mRes.rows
          .filter((m: any) => m.principal_id === p.id)
          .map((m: any) => ({
            membershipId: m.id,
            organizationId: m.organization_id,
            domainRole: m.domain_role,
            validFrom: m.valid_from,
            validTo: m.valid_to ?? null,
            version: Number(m.version || 1)
          }));
        return {
          principalId: p.id,
          externalSubject: p.external_subject,
          kind: p.kind,
          active: p.active !== false,
          deactivatedAt: p.deactivated_at ?? null,
          version: Number(p.version || 1),
          memberships
        };
      });

      res.setHeader("ETag", `"${item.version}"`);
      res.status(200).json(item);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 3. Deactivate tenant user (If-Match + Idempotency-Key + immutable audit)
  app.post("/api/v2/tenant-admin/users/:principalId/deactivate", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.users.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const principalId = String(req.params.principalId);
      assertUuidOr404(principalId, "User");
      const input = PrincipalStatusBody.parse(req.body);

      if (principalId === actor.principalId) {
        throw new AppError("CONFLICT", "Cannot deactivate your own active Tenant Admin account.");
      }

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.user.deactivate",
        idempotencyKey,
        requestHash: computeRequestHash({ principalId, ...input }),
        actor,
        body: async (tx) => {
          const cur = await tx.q(`SELECT id, active, version FROM principal WHERE id = $1`, [principalId]);
          if (!cur.rowCount || cur.rowCount === 0) {
            throw new AppError("NOT_FOUND", "User not found.");
          }
          const curVersion = Number(cur.rows[0].version || 1);
          assertVersionMatch(req, curVersion, "principal");

          await tx.q(
            `UPDATE principal SET active = $1, deactivated_at = now(), version = version + 1 WHERE id = $2`,
            [false, principalId]
          );
          const nextVersion = curVersion + 1;
          return {
            result: { principalId, active: false, version: nextVersion },
            audit: {
              purpose: who.purpose,
              command: "tenant.user.deactivate",
              resourceType: "principal",
              resourceId: principalId,
              resourceVersion: nextVersion,
              result: "SUCCESS" as const,
              evidenceRefs: [`reason:${input.reason.slice(0, 80)}`]
            },
            events: [{
              aggregate: "principal",
              aggregateId: principalId,
              aggregateVersion: nextVersion,
              eventType: "tenant.user.deactivated",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`principal/${principalId}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"${result.body.version}"`);
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 4. Reactivate tenant user
  app.post("/api/v2/tenant-admin/users/:principalId/reactivate", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.users.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const principalId = String(req.params.principalId);
      assertUuidOr404(principalId, "User");
      const input = PrincipalStatusBody.parse(req.body);

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.user.reactivate",
        idempotencyKey,
        requestHash: computeRequestHash({ principalId, ...input }),
        actor,
        body: async (tx) => {
          const cur = await tx.q(`SELECT id, active, version FROM principal WHERE id = $1`, [principalId]);
          if (!cur.rowCount || cur.rowCount === 0) {
            throw new AppError("NOT_FOUND", "User not found.");
          }
          const curVersion = Number(cur.rows[0].version || 1);
          assertVersionMatch(req, curVersion, "principal");

          await tx.q(
            `UPDATE principal SET active = $1, deactivated_at = NULL, version = version + 1 WHERE id = $2`,
            [true, principalId]
          );
          const nextVersion = curVersion + 1;
          return {
            result: { principalId, active: true, version: nextVersion },
            audit: {
              purpose: who.purpose,
              command: "tenant.user.reactivate",
              resourceType: "principal",
              resourceId: principalId,
              resourceVersion: nextVersion,
              result: "SUCCESS" as const,
              evidenceRefs: [`reason:${input.reason.slice(0, 80)}`]
            },
            events: [{
              aggregate: "principal",
              aggregateId: principalId,
              aggregateVersion: nextVersion,
              eventType: "tenant.user.reactivated",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`principal/${principalId}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"${result.body.version}"`);
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 5. Assign effective-dated role membership inside tenant (rechecks approver authority at stated date)
  app.post("/api/v2/tenant-admin/memberships", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.memberships.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const input = AssignTenantMembershipBody.parse(req.body);

      if (!input.principalId && !input.externalSubject) {
        throw new AppError("VALIDATION", "Provide either 'principalId' or 'externalSubject'.");
      }

      const isSelfTarget =
        (input.principalId && input.principalId === actor.principalId) ||
        (input.externalSubject && input.externalSubject.trim().toLowerCase() === who.subject.trim().toLowerCase());
      if (isSelfTarget && (APPROVAL_ROLES as readonly string[]).includes(input.domainRole)) {
        throw new AppError(
          "FORBIDDEN",
          `Separation of duties: Tenant Admin cannot assign approval role '${input.domainRole}' to themselves. Another authorized Tenant Admin must grant approval authority.`
        );
      }

      const validFrom = input.validFrom ?? new Date().toISOString();
      const validTo = input.validTo ?? null;
      if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) {
        throw new AppError("VALIDATION", "'validTo' must be strictly after 'validFrom'.");
      }

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.membership.assign",
        idempotencyKey,
        requestHash: computeRequestHash(input),
        actor,
        body: async (tx) => {
          const orgRes = await tx.q(`SELECT id FROM organization WHERE id = $1`, [input.organizationId]);
          if (!orgRes.rowCount || orgRes.rowCount === 0) {
            throw new AppError("NOT_FOUND", "Organization not found.");
          }

          let principalId = input.principalId ?? "";
          let externalSubject = input.externalSubject ?? "";
          if (principalId) {
            const pRes = await tx.q(`SELECT id, external_subject FROM principal WHERE id = $1`, [principalId]);
            if (!pRes.rowCount || pRes.rowCount === 0) {
              throw new AppError("NOT_FOUND", "User not found.");
            }
            externalSubject = pRes.rows[0].external_subject;
          } else {
            const existingP = await tx.q(`SELECT id, external_subject FROM principal WHERE external_subject = $1`, [externalSubject]);
            if ((existingP.rowCount ?? 0) > 0) {
              principalId = existingP.rows[0].id;
            } else {
              principalId = crypto.randomUUID();
              await tx.q(
                `INSERT INTO principal (id, tenant_id, external_subject, kind) VALUES ($1, $2, $3, $4)`,
                [principalId, who.tenantId, externalSubject, input.kind]
              );
            }
          }

          const membershipId = crypto.randomUUID();
          await tx.q(
            `INSERT INTO effective_membership (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [membershipId, who.tenantId, principalId, input.organizationId, input.domainRole, validFrom, validTo]
          );

          const grantsApproverAuthority = (APPROVAL_ROLES as readonly string[]).includes(input.domainRole);
          const payload = {
            membershipId,
            principalId,
            externalSubject,
            organizationId: input.organizationId,
            domainRole: input.domainRole,
            validFrom,
            validTo,
            version: 1,
            grantsApproverAuthority,
            approverAuthorityEffectiveFrom: grantsApproverAuthority ? validFrom : null
          };

          return {
            result: payload,
            audit: {
              purpose: who.purpose,
              command: "tenant.membership.assign",
              resourceType: "effective_membership",
              resourceId: membershipId,
              resourceVersion: 1,
              result: "SUCCESS" as const,
              evidenceRefs: [
                `role:${input.domainRole}`,
                `valid_from:${validFrom}`,
                ...(isSelfTarget ? ["self_assigned:true"] : [])
              ]
            },
            events: [{
              aggregate: "effective_membership",
              aggregateId: membershipId,
              aggregateVersion: 1,
              eventType: "tenant.membership.assigned",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`principal/${principalId}`, `role/${input.domainRole}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"1"`);
      res.status(result.status === 200 ? 200 : 201).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 6. End a role membership at a stated effective date & recheck remaining approver authority
  app.post("/api/v2/tenant-admin/memberships/:membershipId/end", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.memberships.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const membershipId = String(req.params.membershipId);
      assertUuidOr404(membershipId, "Membership");
      const input = EndMembershipBody.parse(req.body);

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.membership.end",
        idempotencyKey,
        requestHash: computeRequestHash({ membershipId, ...input }),
        actor,
        body: async (tx) => {
          const allM = await tx.q(`SELECT id, principal_id, domain_role, valid_from, valid_to, version FROM effective_membership`);
          const target = allM.rows.find((m: any) => m.id === membershipId);
          if (!target) {
            throw new AppError("NOT_FOUND", "Membership not found.");
          }
          const curVersion = Number(target.version || 1);
          assertVersionMatch(req, curVersion, "effective_membership");

          const minValidTo = new Date(Date.parse(target.valid_from) + 1).toISOString();
          const effectiveEnd = input.validTo
            ? (Date.parse(input.validTo) > Date.parse(target.valid_from) ? input.validTo : minValidTo)
            : (Date.now() > Date.parse(target.valid_from) ? new Date().toISOString() : minValidTo);

          await tx.q(
            `UPDATE effective_membership SET valid_to = $1, version = version + 1 WHERE id = $2 AND tenant_id = $3`,
            [effectiveEnd, membershipId, who.tenantId]
          );

          const checkAtMs = Date.parse(effectiveEnd) + 1;
          const remainingApproverRoles = allM.rows
            .filter((m: any) => m.principal_id === target.principal_id && m.id !== membershipId)
            .filter((m: any) => {
              const fromMs = Date.parse(m.valid_from);
              const toMs = m.valid_to ? Date.parse(m.valid_to) : Infinity;
              return fromMs <= checkAtMs && checkAtMs < toMs && (APPROVAL_ROLES as readonly string[]).includes(m.domain_role);
            })
            .map((m: any) => m.domain_role);

          const nextVersion = curVersion + 1;
          return {
            result: {
              membershipId,
              principalId: target.principal_id,
              endedRole: target.domain_role,
              validTo: effectiveEnd,
              version: nextVersion,
              remainingApproverRoles,
              retainsApprovalAuthorityAfterEnd: remainingApproverRoles.length > 0
            },
            audit: {
              purpose: who.purpose,
              command: "tenant.membership.end",
              resourceType: "effective_membership",
              resourceId: membershipId,
              resourceVersion: nextVersion,
              result: "SUCCESS" as const,
              evidenceRefs: [`valid_to:${effectiveEnd}`, `reason:${input.reason.slice(0, 80)}`]
            },
            events: [{
              aggregate: "effective_membership",
              aggregateId: membershipId,
              aggregateVersion: nextVersion,
              eventType: "tenant.membership.ended",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`principal/${target.principal_id}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"${result.body.version}"`);
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 7. List OIDC Invitations for tenant
  app.get("/api/v2/tenant-admin/invitations", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.users.read", who.role, who.purpose);

      const items = await withTenant(who.tenantId, async (tx) => {
        const r = await tx.q(
          `SELECT id, tenant_id, organization_id, masked_email, external_subject, domain_role, valid_from, valid_to, status, invited_by, reason, created_at, expires_at, accepted_at, revoked_at, version
           FROM tenant_invitation
           ORDER BY created_at DESC`
        );
        return r.rows.map((inv: any) => ({
          id: inv.id,
          organizationId: inv.organization_id,
          maskedEmail: inv.masked_email,
          externalSubject: inv.external_subject ?? null,
          domainRole: inv.domain_role,
          validFrom: inv.valid_from,
          validTo: inv.valid_to ?? null,
          status: inv.status,
          invitedBy: inv.invited_by,
          reason: inv.reason ?? null,
          createdAt: inv.created_at,
          expiresAt: inv.expires_at,
          acceptedAt: inv.accepted_at ?? null,
          revokedAt: inv.revoked_at ?? null,
          version: Number(inv.version || 1)
        }));
      });

      res.status(200).json({ tenantId: who.tenantId, items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 8. Create OIDC Invitation
  app.post("/api/v2/tenant-admin/invitations", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.invitations.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const input = CreateInvitationBody.parse(req.body);

      const callerSubLower = who.subject.trim().toLowerCase();
      const callerNoProvider = callerSubLower.includes("|") ? callerSubLower.split("|").slice(1).join("|") : callerSubLower;
      const inviteEmailLower = input.email.trim().toLowerCase();
      const inviteSubLower = input.externalSubject ? input.externalSubject.trim().toLowerCase() : "";
      const isSelfInvite =
        inviteEmailLower === callerSubLower ||
        inviteEmailLower === callerNoProvider ||
        (Boolean(inviteSubLower) && (inviteSubLower === callerSubLower || inviteSubLower === callerNoProvider));
      if (isSelfInvite && (APPROVAL_ROLES as readonly string[]).includes(input.domainRole)) {
        throw new AppError(
          "FORBIDDEN",
          `Separation of duties: Tenant Admin cannot invite themselves into approval role '${input.domainRole}'.`
        );
      }

      const validFrom = input.validFrom ?? new Date().toISOString();
      const validTo = input.validTo ?? null;
      if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) {
        throw new AppError("VALIDATION", "'validTo' must be strictly after 'validFrom'.");
      }

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.invitation.create",
        idempotencyKey,
        requestHash: computeRequestHash(input),
        actor,
        body: async (tx) => {
          const orgRes = await tx.q(`SELECT id FROM organization WHERE id = $1`, [input.organizationId]);
          if (!orgRes.rowCount || orgRes.rowCount === 0) {
            throw new AppError("NOT_FOUND", "Organization not found.");
          }

          const id = crypto.randomUUID();
          const maskedEmail = maskSubjectIdentifier(input.email);
          const emailHash = hashEmail(input.email);
          const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 3600 * 1000).toISOString();

          await tx.q(
            `INSERT INTO tenant_invitation (
               id, tenant_id, organization_id, masked_email, email_hash, external_subject, domain_role, valid_from, valid_to, invited_by, reason, expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              id,
              who.tenantId,
              input.organizationId,
              maskedEmail,
              emailHash,
              input.externalSubject ?? null,
              input.domainRole,
              validFrom,
              validTo,
              actor.principalId,
              input.reason,
              expiresAt
            ]
          );

          const out = {
            id,
            organizationId: input.organizationId,
            maskedEmail,
            externalSubject: input.externalSubject ?? null,
            domainRole: input.domainRole,
            validFrom,
            validTo,
            status: "PENDING",
            expiresAt,
            version: 1
          };

          return {
            result: out,
            audit: {
              purpose: who.purpose,
              command: "tenant.invitation.create",
              resourceType: "tenant_invitation",
              resourceId: id,
              resourceVersion: 1,
              result: "SUCCESS" as const,
              evidenceRefs: [`role:${input.domainRole}`, `invite:${maskedEmail}`]
            },
            events: [{
              aggregate: "tenant_invitation",
              aggregateId: id,
              aggregateVersion: 1,
              eventType: "tenant.invitation.created",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`invitation/${id}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"1"`);
      res.status(result.status === 200 ? 200 : 201).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 9. Revoke OIDC Invitation
  app.post("/api/v2/tenant-admin/invitations/:invitationId/revoke", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.invitations.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const invitationId = String(req.params.invitationId);
      assertUuidOr404(invitationId, "Invitation");
      const input = RevokeInvitationBody.parse(req.body);

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.invitation.revoke",
        idempotencyKey,
        requestHash: computeRequestHash({ invitationId, ...input }),
        actor,
        body: async (tx) => {
          const cur = await tx.q(`SELECT id, status, version FROM tenant_invitation WHERE id = $1`, [invitationId]);
          if (!cur.rowCount || cur.rowCount === 0) {
            throw new AppError("NOT_FOUND", "Invitation not found.");
          }
          const inv = cur.rows[0];
          const curVersion = Number(inv.version || 1);
          assertVersionMatch(req, curVersion, "tenant_invitation");
          if (inv.status !== "PENDING") {
            throw new AppError("CONFLICT", `Invitation is already '${inv.status}'.`);
          }
          await tx.q(
            `UPDATE tenant_invitation SET status = $1, revoked_at = now(), version = version + 1 WHERE id = $2`,
            ["REVOKED", invitationId]
          );
          const nextVersion = curVersion + 1;
          return {
            result: { id: invitationId, status: "REVOKED", version: nextVersion },
            audit: {
              purpose: who.purpose,
              command: "tenant.invitation.revoke",
              resourceType: "tenant_invitation",
              resourceId: invitationId,
              resourceVersion: nextVersion,
              result: "SUCCESS" as const,
              evidenceRefs: [`reason:${input.reason.slice(0, 80)}`]
            },
            events: [{
              aggregate: "tenant_invitation",
              aggregateId: invitationId,
              aggregateVersion: nextVersion,
              eventType: "tenant.invitation.revoked",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`invitation/${invitationId}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"${result.body.version}"`);
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 10. Update Organization Unit / Team (If-Match + Idempotency-Key + RLS isolation)
  app.patch("/api/v2/tenant-admin/organizations/:orgId", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.organization.manage", who.role, who.purpose);
      const idempotencyKey = requireIdempotencyKey(req);
      const orgId = String(req.params.orgId);
      assertUuidOr404(orgId, "Organization");
      const input = UpdateOrganizationBody.parse(req.body);

      if (input.parentId && input.parentId === orgId) {
        throw new AppError("VALIDATION", "An organization cannot be its own parent.");
      }

      const result = await runCommand({
        tenantId: who.tenantId,
        operation: "tenant.organization.update",
        idempotencyKey,
        requestHash: computeRequestHash({ orgId, ...input }),
        actor,
        body: async (tx) => {
          const cur = await tx.q(`SELECT id, name, parent_id, version FROM organization WHERE id = $1`, [orgId]);
          if (!cur.rowCount || cur.rowCount === 0) {
            throw new AppError("NOT_FOUND", "Organization not found.");
          }
          const curVersion = Number(cur.rows[0].version || 1);
          assertVersionMatch(req, curVersion, "organization");

          if (input.parentId) {
            const pRes = await tx.q(`SELECT id FROM organization WHERE id = $1`, [input.parentId]);
            if (!pRes.rowCount || pRes.rowCount === 0) {
              throw new AppError("NOT_FOUND", "Parent organization not found.");
            }
          }

          const nextParentId = input.parentId !== undefined ? input.parentId : (cur.rows[0].parent_id ?? null);
          await tx.q(
            `UPDATE organization SET name = $1, parent_id = $2, version = version + 1 WHERE id = $3`,
            [input.name, nextParentId, orgId]
          );
          const nextVersion = curVersion + 1;
          return {
            result: { id: orgId, name: input.name, parentId: nextParentId, version: nextVersion },
            audit: {
              purpose: who.purpose,
              command: "tenant.organization.update",
              resourceType: "organization",
              resourceId: orgId,
              resourceVersion: nextVersion,
              result: "SUCCESS" as const,
              evidenceRefs: [`reason:${input.reason.slice(0, 80)}`]
            },
            events: [{
              aggregate: "organization",
              aggregateId: orgId,
              aggregateVersion: nextVersion,
              eventType: "organization.updated",
              schemaVersion: "v1.0",
              purpose: who.purpose,
              refs: [`organization/${orgId}`]
            }]
          };
        }
      });

      res.setHeader("ETag", `"${result.body.version}"`);
      res.status(result.status).json(result.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 11. Searchable Own Tenant Audit View (strictly isolated to caller's tenant)
  app.get("/api/v2/tenant-admin/audit", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.audit.read", who.role, who.purpose);

      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const commandFilter = typeof req.query.command === "string" ? req.query.command.trim().toLowerCase() : "";
      const resourceTypeFilter = typeof req.query.resourceType === "string" ? req.query.resourceType.trim().toLowerCase() : "";
      const resultFilter = typeof req.query.result === "string" ? req.query.result.trim().toUpperCase() : "";
      const fromTs = typeof req.query.from === "string" && req.query.from ? Date.parse(req.query.from) : null;
      const toTs = typeof req.query.to === "string" && req.query.to ? Date.parse(req.query.to) : null;
      const limit = parseLimit(req, 100, 500);

      const items = await withTenant(who.tenantId, async (tx) => {
        const r = await tx.q(`SELECT * FROM audit_event ORDER BY occurred_at DESC LIMIT 500`);
        return r.rows
          .filter((evt: any) => {
            if (commandFilter && !String(evt.command || "").toLowerCase().includes(commandFilter)) return false;
            if (resourceTypeFilter && !String(evt.resource_type || "").toLowerCase().includes(resourceTypeFilter)) return false;
            if (resultFilter && String(evt.result || "").toUpperCase() !== resultFilter) return false;
            const ts = Date.parse(evt.occurred_at);
            if (fromTs && Number.isFinite(fromTs) && ts < fromTs) return false;
            if (toTs && Number.isFinite(toTs) && ts > toTs) return false;
            if (q) {
              const hay = `${evt.id} ${evt.command} ${evt.resource_type} ${evt.resource_id} ${evt.purpose} ${evt.actor_id} ${JSON.stringify(evt.evidence_refs || [])}`.toLowerCase();
              if (!hay.includes(q)) return false;
            }
            return true;
          })
          .slice(0, limit);
      });

      res.status(200).json({ tenantId: who.tenantId, items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 12. Tenant's Own Rights Requests History
  app.get("/api/v2/tenant-admin/rights-requests", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.users.read", who.role, who.purpose);

      const items = await withTenant(who.tenantId, async (tx) => {
        const r = await tx.q(`SELECT * FROM rights_request ORDER BY requested_at DESC LIMIT 100`);
        return r.rows;
      });
      res.status(200).json({ tenantId: who.tenantId, items });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // 13. Unified Tenant Usage View (AI quota remaining, entitlements, tenant-scoped connector health)
  app.get("/api/v2/tenant-admin/usage", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      authorizeTenantAdmin(actor, "tenant.usage.read", who.role, who.purpose);

      const data = await withTenant(who.tenantId, async (tx) => {
        const [aiQuota, connRes, customEntRes, quotaCfgRes] = await Promise.all([
          getAiQuotaStatus(tx),
          tx.q(`SELECT id, source, state, last_success_at, expected_cadence_seconds, version FROM connection`),
          tx.q(`SELECT feature_key, enabled, notes, updated_at, version FROM tenant_entitlement`),
          tx.q(`SELECT monthly_budget_minor, updated_at, version FROM tenant_ai_quota_config`)
        ]);
        const entitlementsView = getDefaultEntitlements(who.tenantId);

        const connections = connRes.rows.map((c: any) => {
          const last = c.last_success_at ? new Date(c.last_success_at).getTime() : null;
          const cadence = Number(c.expected_cadence_seconds || 3600);
          const lagSec = last ? (Date.now() - last) / 1000 : Infinity;
          const health = !last ? "NEVER_SYNCED" : lagSec > cadence * 3 ? "STALE" : lagSec > cadence * 1.5 ? "DELAYED" : "FRESH";
          return {
            id: c.id,
            source: c.source,
            state: c.state,
            health,
            lastSuccessAt: c.last_success_at ?? null,
            expectedCadenceSeconds: cadence,
            version: Number(c.version || 1)
          };
        });

        const totalBudget = aiQuota.useCases.reduce((acc: number, u) => acc + u.monthlyBudgetMinor, 0);
        const totalSpent = aiQuota.useCases.reduce((acc: number, u) => acc + u.spentMinor, 0);
        const configuredBudgetCap = quotaCfgRes.rows[0] ? Number(quotaCfgRes.rows[0].monthly_budget_minor) : null;

        return {
          tenantId: who.tenantId,
          aiQuota: {
            ...aiQuota,
            configuredBudgetCapMinor: configuredBudgetCap,
            totalBudgetMinor: configuredBudgetCap ?? totalBudget,
            totalSpentMinor: totalSpent,
            totalRemainingMinor: Math.max(0, (configuredBudgetCap ?? totalBudget) - totalSpent)
          },
          entitlements: entitlementsView,
          platformEntitlements: customEntRes.rows.map((e: any) => ({
            featureKey: e.feature_key,
            enabled: Boolean(e.enabled),
            notes: e.notes ?? null,
            updatedAt: e.updated_at,
            version: Number(e.version || 1)
          })),
          connections
        };
      });

      res.status(200).json(data);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });
}
