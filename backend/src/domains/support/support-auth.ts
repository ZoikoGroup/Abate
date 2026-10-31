// backend/src/domains/support/support-auth.ts
import jwt from "jsonwebtoken";
import { loadConfig } from "../../platform/config";
import { AppError } from "../../platform/errors";

const cfg = loadConfig();

/**
 * Zero-impersonation support model (B8): support operators authenticate with their own token,
 * issued for a separate audience and carrying no tenant claim. Tenant endpoints verify the tenant
 * audience, so a support token can never act as, or read as, a tenant principal; and tenant
 * tokens are refused on the ops plane.
 */
export const SUPPORT_AUDIENCE = `${cfg.authAudience}:support`;
export const SUPPORT_SCOPE = "platform-support";

export interface SupportIdentity {
  operator: string;
  scope: typeof SUPPORT_SCOPE;
}

export function createSupportToken(payload: { operator: string }): string {
  return jwt.sign(
    { sub: payload.operator, scope: SUPPORT_SCOPE },
    cfg.supportAuthSecret,
    { issuer: cfg.authIssuer, audience: SUPPORT_AUDIENCE, expiresIn: "1h" }
  );
}

export function authenticateSupport(authHeader: string | null | undefined): SupportIdentity {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", "Support authentication required.");
  }

  let decoded: any;
  try {
    decoded = jwt.verify(authHeader.slice(7), cfg.supportAuthSecret, {
      issuer: cfg.authIssuer,
      audience: SUPPORT_AUDIENCE
    });
  } catch {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired support token.");
  }

  // A support credential bound to a tenant would be impersonation by another name
  if (decoded.scope !== SUPPORT_SCOPE || !decoded.sub || decoded.tenant_id !== undefined) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired support token.");
  }

  return { operator: decoded.sub as string, scope: SUPPORT_SCOPE };
}
