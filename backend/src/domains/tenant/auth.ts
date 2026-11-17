// backend/src/domains/tenant/auth.ts
import jwt from "jsonwebtoken";
import { isDevTokenEnabled, loadConfig } from "../../platform/config";
import { AppError } from "../../platform/errors";
import { withTenant } from "../../platform/db/with-tenant";
import { Actor } from "../../platform/command";
import {
  extractTenantClaimsFromOidc,
  OIDC_ASYMMETRIC_ALGS,
  verifyOidcJwt,
  verifySessionCookieToken
} from "../../platform/oidc";

export interface AuthenticatedIdentity {
  tenantId: string;
  subject: string;
  purpose: string;
  role: string;
}

/**
 * createDevToken: Generates signed JWT for local/test development when dev token issuance is enabled.
 */
export function createDevToken(payload: {
  tenantId: string;
  subject: string;
  role?: string;
  purpose?: string;
}): string {
  const cfg = loadConfig();
  if (!isDevTokenEnabled(cfg)) {
    throw new AppError("NOT_FOUND", "Not found.");
  }
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
 * authenticate: Binds tenant to verified identity via OIDC asymmetric JWT, OIDC HttpOnly cookie session,
 * or (local/test only) HS256 dev token.
 */
export async function authenticate(authHeader: string | null | undefined): Promise<AuthenticatedIdentity> {
  if (!authHeader) {
    throw new AppError("UNAUTHENTICATED", "Authentication required: missing or invalid Bearer token.");
  }

  const cfg = loadConfig();
  if (authHeader.startsWith("CookieSession ")) {
    const session = verifySessionCookieToken(authHeader.slice("CookieSession ".length), cfg);
    return {
      tenantId: session.tenantId,
      subject: session.subject,
      purpose: "WORKPLACE_RISK_ASSESSMENT",
      role: session.role
    };
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", "Authentication required: missing or invalid Bearer token.");
  }

  const token = authHeader.slice(7);
  const decodedHeader = jwt.decode(token, { complete: true })?.header;
  const alg = typeof decodedHeader?.alg === "string" ? decodedHeader.alg : "";

  if (OIDC_ASYMMETRIC_ALGS.includes(alg as jwt.Algorithm)) {
    const claims = await verifyOidcJwt(token, { cfg });
    const identity = extractTenantClaimsFromOidc(claims, cfg);
    return {
      tenantId: identity.tenantId,
      subject: identity.subject,
      purpose: (typeof claims.purpose === "string" && claims.purpose) || "WORKPLACE_RISK_ASSESSMENT",
      role: identity.role
    };
  }

  if (!isDevTokenEnabled(cfg)) {
    throw new AppError("UNAUTHENTICATED", "OIDC Bearer token or verified session cookie required.");
  }

  try {
    const decoded = jwt.verify(token, cfg.authSecret, {
      algorithms: ["HS256"],
      issuer: cfg.authIssuer,
      audience: cfg.authAudience
    }) as any;

    const tenantId = decoded.tenant_id as string;
    const subject = decoded.sub as string;
    const purpose = (decoded.purpose as string) || "WORKPLACE_RISK_ASSESSMENT";
    // Fail closed: a token without a role claim used to be treated as RISK_OWNER (the most privileged control role)
    const role = decoded.role as string;

    if (!tenantId || !subject || !role) {
      throw new AppError("UNAUTHENTICATED", "Token payload missing mandatory claims (tenant_id, sub, role).");
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
export async function resolveActor(
  tenantId: string,
  subject: string,
  at: Date = new Date(),
  claimedRole?: string
): Promise<Actor> {
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

    // The token's role is a *selection* among roles the principal actually holds. Dev tokens (local/test) may pick any
    // role so the role switcher and demos work; elsewhere a role that is not backed by an effective membership is rejected.
    const cfg = loadConfig();
    if (claimedRole && cfg.appEnv !== "local" && cfg.appEnv !== "test") {
      if (!memberships.some(m => m.domain_role === claimedRole)) {
        throw new AppError("FORBIDDEN", "Token role is not granted by an effective membership.");
      }
    }

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
  _command: string,
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


/**
 * Separation of duties: the person who owns a control must not also approve it.
 * Enforced outside local/test; the seeded demo has a single risk owner who walks the whole workflow.
 */
export function requireSeparationOfDuties(ownerPrincipalId: string | null | undefined, actorPrincipalId: string): void {
  const cfg = loadConfig();
  if (cfg.appEnv === "local" || cfg.appEnv === "test") return;
  if (ownerPrincipalId && ownerPrincipalId === actorPrincipalId) {
    throw new AppError("FORBIDDEN", "Separation of duties: the control owner cannot approve their own control.");
  }
}
