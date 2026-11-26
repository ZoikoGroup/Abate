// backend/src/domains/support/support-auth.ts
import jwt from "jsonwebtoken";
import { isDevTokenEnabled, loadConfig } from "../../platform/config";
import { AppError } from "../../platform/errors";
import { OIDC_ASYMMETRIC_ALGS, verifyOidcJwt } from "../../platform/oidc";

const initialCfg = loadConfig();

/**
 * Zero-impersonation support model (B8): support operators authenticate with their own token,
 * issued for a separate audience and carrying no tenant claim. Tenant endpoints verify the tenant
 * audience, so a support token can never act as, or read as, a tenant principal; and tenant
 * tokens are refused on the ops plane.
 */
export const SUPPORT_AUDIENCE = `${initialCfg.authAudience}:support`;
export const SUPPORT_SCOPE = "platform-support";
export const SUPER_ADMIN_SCOPE = "platform-super-admin";

export interface SupportIdentity {
  operator: string;
  scope: typeof SUPPORT_SCOPE | typeof SUPER_ADMIN_SCOPE;
  role: "OPS_SUPPORT" | "SUPER_ADMIN";
}

export function createSupportToken(payload: { operator: string }): string {
  const cfg = loadConfig();
  return jwt.sign(
    { sub: payload.operator, scope: SUPPORT_SCOPE, role: "OPS_SUPPORT" },
    cfg.supportAuthSecret,
    { issuer: cfg.authIssuer, audience: `${cfg.authAudience}:support`, expiresIn: "1h" }
  );
}

export function createSuperAdminToken(payload: { operator: string }): string {
  const cfg = loadConfig();
  return jwt.sign(
    { sub: payload.operator, scope: SUPER_ADMIN_SCOPE, role: "SUPER_ADMIN" },
    cfg.supportAuthSecret,
    { issuer: cfg.authIssuer, audience: `${cfg.authAudience}:support`, expiresIn: "2h" }
  );
}

function validateSupportClaims(decoded: any, requireSuperAdmin = false): SupportIdentity {
  // A support or super-admin credential bound to a tenant would be impersonation by another name
  if (!decoded || !decoded.sub || decoded.tenant_id !== undefined) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired platform operator token.");
  }
  const isSuper = decoded.scope === SUPER_ADMIN_SCOPE;
  const isSupport = decoded.scope === SUPPORT_SCOPE;
  if (!isSuper && !isSupport) {
    throw new AppError("UNAUTHENTICATED", "Invalid platform operator scope.");
  }
  if (requireSuperAdmin && !isSuper) {
    throw new AppError("FORBIDDEN", "Super Admin privileges are required for this operation.");
  }
  return {
    operator: decoded.sub as string,
    scope: isSuper ? SUPER_ADMIN_SCOPE : SUPPORT_SCOPE,
    role: isSuper ? "SUPER_ADMIN" : "OPS_SUPPORT"
  };
}

export async function authenticateSupport(authHeader: string | null | undefined): Promise<SupportIdentity> {
  return authenticatePlatformOperator(authHeader, false);
}

export async function authenticateSuperAdmin(authHeader: string | null | undefined): Promise<SupportIdentity> {
  return authenticatePlatformOperator(authHeader, true);
}

async function authenticatePlatformOperator(
  authHeader: string | null | undefined,
  requireSuperAdmin: boolean
): Promise<SupportIdentity> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", "Platform operator authentication required.");
  }

  const token = authHeader.slice(7);
  const cfg = loadConfig();
  const supportAudience = `${cfg.authAudience}:support`;
  const decodedHeader = jwt.decode(token, { complete: true })?.header;
  const alg = typeof decodedHeader?.alg === "string" ? decodedHeader.alg : "";

  if (OIDC_ASYMMETRIC_ALGS.includes(alg as jwt.Algorithm)) {
    const claims = await verifyOidcJwt(token, { audience: supportAudience, cfg });
    return validateSupportClaims(claims, requireSuperAdmin);
  }

  if (!isDevTokenEnabled(cfg)) {
    throw new AppError("UNAUTHENTICATED", "OIDC platform operator token required when dev tokens are disabled.");
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, cfg.supportAuthSecret, {
      algorithms: ["HS256"],
      issuer: cfg.authIssuer,
      audience: supportAudience
    });
  } catch {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired platform operator token.");
  }

  return validateSupportClaims(decoded, requireSuperAdmin);
}
