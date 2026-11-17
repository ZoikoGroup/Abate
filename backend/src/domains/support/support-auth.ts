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

export interface SupportIdentity {
  operator: string;
  scope: typeof SUPPORT_SCOPE;
}

export function createSupportToken(payload: { operator: string }): string {
  const cfg = loadConfig();
  return jwt.sign(
    { sub: payload.operator, scope: SUPPORT_SCOPE },
    cfg.supportAuthSecret,
    { issuer: cfg.authIssuer, audience: `${cfg.authAudience}:support`, expiresIn: "1h" }
  );
}

function validateSupportClaims(decoded: any): SupportIdentity {
  // A support credential bound to a tenant would be impersonation by another name
  if (!decoded || decoded.scope !== SUPPORT_SCOPE || !decoded.sub || decoded.tenant_id !== undefined) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired support token.");
  }
  return { operator: decoded.sub as string, scope: SUPPORT_SCOPE };
}

export async function authenticateSupport(authHeader: string | null | undefined): Promise<SupportIdentity> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", "Support authentication required.");
  }

  const token = authHeader.slice(7);
  const cfg = loadConfig();
  const supportAudience = `${cfg.authAudience}:support`;
  const decodedHeader = jwt.decode(token, { complete: true })?.header;
  const alg = typeof decodedHeader?.alg === "string" ? decodedHeader.alg : "";

  if (OIDC_ASYMMETRIC_ALGS.includes(alg as jwt.Algorithm)) {
    const claims = await verifyOidcJwt(token, { audience: supportAudience, cfg });
    return validateSupportClaims(claims);
  }

  if (!isDevTokenEnabled(cfg)) {
    throw new AppError("UNAUTHENTICATED", "OIDC support token required when dev tokens are disabled.");
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, cfg.supportAuthSecret, {
      algorithms: ["HS256"],
      issuer: cfg.authIssuer,
      audience: supportAudience
    });
  } catch {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired support token.");
  }

  return validateSupportClaims(decoded);
}
