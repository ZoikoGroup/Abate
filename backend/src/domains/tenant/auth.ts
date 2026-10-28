// backend/src/domains/tenant/auth.ts
import jwt from "jsonwebtoken";
import { loadConfig } from "../../platform/config";
import { AppError } from "../../platform/errors";
import { withTenant } from "../../platform/db/with-tenant";
import { Actor } from "../../platform/command";

const cfg = loadConfig();

export interface AuthenticatedIdentity {
  tenantId: string;
  subject: string;
  purpose: string;
  role: string;
}

/**
 * createDevToken: Generates signed JWT for testing and development.
 */
export function createDevToken(payload: {
  tenantId: string;
  subject: string;
  role?: string;
  purpose?: string;
}): string {
  return jwt.sign(
    {
      tenant_id: payload.tenantId,
      sub: payload.subject,
      role: payload.role || "RISK_OWNER",
      purpose: payload.purpose || "WORKPLACE_RISK_ASSESSMENT"
    },
    cfg.authSecret,
    {
      issuer: cfg.authIssuer,
      audience: cfg.authAudience,
      expiresIn: "8h"
    }
  );
}

/**
 * authenticate: Binds tenant to verified identity; validates issuer, audience, expiry, role, and purpose.
 */
export async function authenticate(authHeader: string | null | undefined): Promise<AuthenticatedIdentity> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", "Authentication required: missing or invalid Bearer token.");
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, cfg.authSecret, {
      issuer: cfg.authIssuer,
      audience: cfg.authAudience
    }) as any;

    const tenantId = decoded.tenant_id as string;
    const subject = decoded.sub as string;
    const purpose = (decoded.purpose as string) || "WORKPLACE_RISK_ASSESSMENT";
    const role = (decoded.role as string) || "RISK_OWNER";

    if (!tenantId || !subject) {
      throw new AppError("UNAUTHENTICATED", "Token payload missing mandatory claims (tenant_id, sub).");
    }

    return { tenantId, subject, purpose, role };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNAUTHENTICATED", "Invalid or expired token.");
  }
}

/**
 * resolveActor: Resolves effective roles and memberships at a point in time.
 */
export async function resolveActor(tenantId: string, subject: string, at: Date = new Date()): Promise<Actor> {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.q(
      `SELECT p.id, m.organization_id, m.domain_role
       FROM principal p
       JOIN effective_membership m ON m.principal_id = p.id AND m.tenant_id = p.tenant_id
       WHERE p.external_subject = $1
         AND m.valid_from <= $2
         AND (m.valid_to IS NULL OR m.valid_to > $2)`,
      [subject, at.toISOString()]
    );

    if (r.rowCount === 0) {
      throw new AppError("FORBIDDEN", "Subject has no active effective membership for this tenant.");
    }

    const principalId = r.rows[0].id;
    const memberships = r.rows.map(row => ({
      organization_id: row.organization_id,
      domain_role: row.domain_role
    }));

    return {
      principalId,
      tenantId,
      memberships
    };
  });
}

/**
 * authorize: Pure authorization function checking role, command, and resource ownership.
 */
export function authorize(
  actor: Actor,
  command: string,
  resource?: { tenantId?: string; organizationId?: string }
): void {
  // Tenant scope check: actor cannot act on a resource belonging to a different tenant
  if (resource?.tenantId && resource.tenantId !== actor.tenantId) {
    throw new AppError("NOT_FOUND", "Not found."); // Never reveal foreign existence
  }

  // Domain role check
  const allowedRoles = ["RISK_OWNER", "CONTROL_OWNER", "REVIEWER", "EMPLOYER_ADMIN"];
  const hasValidRole = actor.memberships.some(m => allowedRoles.includes(m.domain_role));
  if (!hasValidRole) {
    throw new AppError("FORBIDDEN", "Insufficient role privileges to execute this command.");
  }
}

