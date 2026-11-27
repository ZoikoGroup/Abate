// backend/src/domains/support/support-auth.ts
import crypto from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AppConfig, isDevTokenEnabled, loadConfig } from "../../platform/config";
import { AppError } from "../../platform/errors";
import { OIDC_ASYMMETRIC_ALGS, readCookieFromHeader, verifyOidcJwt } from "../../platform/oidc";

const initialCfg = loadConfig();

/**
 * Zero-impersonation platform operator model (B8 / ADR-007):
 * Platform operators (OPS_SUPPORT and SUPER_ADMIN) authenticate with a separate audience and secret,
 * carrying NO tenant_id claim. Tenant endpoints verify the tenant audience, so platform credentials
 * can never read or act as a tenant principal; and tenant tokens are refused on ops/admin planes.
 */
export const SUPPORT_AUDIENCE = `${initialCfg.authAudience}:support`;
export const SUPPORT_SCOPE = "platform-support";
export const SUPER_ADMIN_SCOPE = "platform-super-admin";
export const ADMIN_SESSION_COOKIE_NAME = "abate_admin_session";
export const ADMIN_CSRF_COOKIE_NAME = "abate_admin_csrf";

export interface SupportIdentity {
  operator: string;
  scope: typeof SUPPORT_SCOPE | typeof SUPER_ADMIN_SCOPE;
  role: "OPS_SUPPORT" | "SUPER_ADMIN";
  authMethod: "bearer" | "admin_cookie" | "oidc";
  mfaVerified: boolean;
  stepUpAt: number | null;
  iat: number | null;
  exp: number | null;
}

export function createSupportToken(payload: { operator: string; ttlSeconds?: number }): string {
  const cfg = loadConfig();
  const ttl = Math.max(60, Math.min(payload.ttlSeconds ?? 3600, 3600));
  return jwt.sign(
    { sub: payload.operator, scope: SUPPORT_SCOPE, role: "OPS_SUPPORT", mfa: true },
    cfg.supportAuthSecret,
    { issuer: cfg.authIssuer, audience: `${cfg.authAudience}:support`, expiresIn: ttl }
  );
}

export function createSuperAdminToken(payload: {
  operator: string;
  stepUpAt?: number | null;
  mfaVerified?: boolean;
  ttlSeconds?: number;
}): string {
  const cfg = loadConfig();
  const ttl = Math.max(60, Math.min(payload.ttlSeconds ?? cfg.adminSessionTtlSeconds, 3600));
  const claims: Record<string, unknown> = {
    sub: payload.operator,
    scope: SUPER_ADMIN_SCOPE,
    role: "SUPER_ADMIN",
    mfa: payload.mfaVerified !== false
  };
  if (typeof payload.stepUpAt === "number" && Number.isFinite(payload.stepUpAt)) {
    claims.step_up_at = Math.floor(payload.stepUpAt);
  }
  return jwt.sign(
    claims,
    cfg.supportAuthSecret,
    { issuer: cfg.authIssuer, audience: `${cfg.authAudience}:support`, expiresIn: ttl }
  );
}

export function formatAdminSessionCookies(
  token: string,
  csrfToken: string,
  maxAgeSeconds?: number,
  cfg: AppConfig = loadConfig()
): string[] {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds ?? cfg.adminSessionTtlSeconds));
  const sessionParts = [
    `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/v2",
    `Max-Age=${maxAge}`
  ];
  const csrfParts = [
    `${ADMIN_CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`,
    "SameSite=Strict",
    "Path=/api/v2",
    `Max-Age=${maxAge}`
  ];
  if (cfg.cookieSecure) {
    sessionParts.push("Secure");
    csrfParts.push("Secure");
  }
  return [sessionParts.join("; "), csrfParts.join("; ")];
}

export function formatClearAdminSessionCookies(cfg: AppConfig = loadConfig()): string[] {
  const sessionParts = [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/v2",
    "Max-Age=0"
  ];
  const csrfParts = [
    `${ADMIN_CSRF_COOKIE_NAME}=`,
    "SameSite=Strict",
    "Path=/api/v2",
    "Max-Age=0"
  ];
  if (cfg.cookieSecure) {
    sessionParts.push("Secure");
    csrfParts.push("Secure");
  }
  return [sessionParts.join("; "), csrfParts.join("; ")];
}

export function setAdminSessionCookies(res: Response, token: string, cfg: AppConfig = loadConfig()): string {
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  res.setHeader("Set-Cookie", formatAdminSessionCookies(token, csrfToken, cfg.adminSessionTtlSeconds, cfg));
  return csrfToken;
}

const ADMIN_OIDC_SESSION_TYP = "admin_oidc_session";

function deriveAdminSessionCookieKey(cfg: AppConfig): Buffer {
  return crypto.createHmac("sha256", cfg.supportAuthSecret).update("abate-admin-oidc-session-v1").digest();
}

export function createAdminOidcSessionCookieToken(
  payload: { operator: string; stepUpAt: number | null; mfaVerified: boolean },
  ttlSeconds?: number,
  cfg: AppConfig = loadConfig()
): string {
  const ttl = Math.max(60, Math.min(ttlSeconds ?? cfg.adminSessionTtlSeconds, cfg.adminSessionTtlSeconds));
  const claims: Record<string, unknown> = {
    sub: payload.operator,
    scope: SUPER_ADMIN_SCOPE,
    role: "SUPER_ADMIN",
    typ: ADMIN_OIDC_SESSION_TYP,
    auth_method: "oidc",
    mfa: payload.mfaVerified
  };
  if (typeof payload.stepUpAt === "number" && Number.isFinite(payload.stepUpAt)) {
    claims.auth_time = Math.floor(payload.stepUpAt);
  }
  return jwt.sign(claims, deriveAdminSessionCookieKey(cfg), {
    algorithm: "HS256",
    issuer: cfg.authIssuer,
    audience: `${cfg.authAudience}:admin-session`,
    expiresIn: ttl
  });
}

export function verifyAdminOidcSessionCookieToken(token: string, cfg: AppConfig = loadConfig()): SupportIdentity | null {
  let decoded: any;
  try {
    decoded = jwt.verify(token, deriveAdminSessionCookieKey(cfg), {
      algorithms: ["HS256"],
      issuer: cfg.authIssuer,
      audience: `${cfg.authAudience}:admin-session`
    });
  } catch {
    return null;
  }
  if (
    !decoded ||
    decoded.typ !== ADMIN_OIDC_SESSION_TYP ||
    decoded.auth_method !== "oidc" ||
    decoded.scope !== SUPER_ADMIN_SCOPE ||
    decoded.tenant_id !== undefined ||
    typeof decoded.sub !== "string" ||
    !decoded.sub
  ) {
    return null;
  }
  if (decoded.mfa !== true) {
    throw new AppError("UNAUTHENTICATED", "OIDC MFA verification is required for Super Admin sessions.");
  }
  return {
    operator: decoded.sub,
    scope: SUPER_ADMIN_SCOPE,
    role: "SUPER_ADMIN",
    authMethod: "oidc",
    mfaVerified: true,
    stepUpAt: typeof decoded.auth_time === "number" ? decoded.auth_time : null,
    iat: typeof decoded.iat === "number" ? decoded.iat : null,
    exp: typeof decoded.exp === "number" ? decoded.exp : null
  };
}

function validateSupportClaims(
  decoded: any,
  requireSuperAdmin: boolean,
  authMethod: "bearer" | "admin_cookie" | "oidc"
): SupportIdentity {
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
  const amr: string[] = Array.isArray(decoded.amr) ? decoded.amr.map((x: any) => String(x).toLowerCase()) : [];
  const acr = typeof decoded.acr === "string" ? decoded.acr.toLowerCase() : "";
  const oidcMfaSatisfied =
    amr.includes("mfa") ||
    amr.includes("hwk") ||
    amr.includes("otp") ||
    amr.includes("webauthn") ||
    amr.includes("fido") ||
    acr.includes("mfa") ||
    acr.includes("aal2") ||
    acr.includes("aal3");
  const mfaVerified = authMethod === "oidc" ? oidcMfaSatisfied : decoded.mfa !== false;

  if (authMethod === "oidc" && requireSuperAdmin && !mfaVerified) {
    throw new AppError(
      "UNAUTHENTICATED",
      "OIDC MFA (amr claim such as mfa/hwk/otp/webauthn or MFA acr) is required for Platform Super Admin access."
    );
  }

  // In OIDC mode, step-up strictly trusts the IdP's signed auth_time claim (never an arbitrary step_up_at claim)
  const rawStepUp = authMethod === "oidc"
    ? (typeof decoded.auth_time === "number" ? decoded.auth_time : null)
    : (typeof decoded.step_up_at === "number"
        ? decoded.step_up_at
        : typeof decoded.auth_time === "number"
          ? decoded.auth_time
          : null);

  return {
    operator: String(decoded.sub),
    scope: isSuper ? SUPER_ADMIN_SCOPE : SUPPORT_SCOPE,
    role: isSuper ? "SUPER_ADMIN" : "OPS_SUPPORT",
    authMethod,
    mfaVerified,
    stepUpAt: rawStepUp,
    iat: typeof decoded.iat === "number" ? decoded.iat : null,
    exp: typeof decoded.exp === "number" ? decoded.exp : null
  };
}

export async function authenticateSupport(authHeader: string | null | undefined): Promise<SupportIdentity> {
  return authenticatePlatformOperator(authHeader, false, "bearer");
}

export async function authenticateSuperAdmin(authHeader: string | null | undefined): Promise<SupportIdentity> {
  return authenticatePlatformOperator(authHeader, true, "bearer");
}

export function assertAdminIpAllowed(req: Request, cfg: AppConfig = loadConfig()): void {
  if (!cfg.adminIpAllowlist || cfg.adminIpAllowlist.length === 0) return;
  const ip = String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (!cfg.adminIpAllowlist.includes(ip)) {
    throw new AppError("FORBIDDEN", "Client IP is not permitted by the platform admin allow-list.");
  }
}

/**
 * Full request authenticator for /api/v2/admin/*:
 * 1. Enforces optional ADMIN_IP_ALLOWLIST.
 * 2. Accepts Bearer JWT or dedicated HttpOnly SameSite=Strict `abate_admin_session` cookie.
 * 3. For cookie-authenticated mutations (POST/PUT/PATCH/DELETE), requires matching X-Admin-Csrf double-submit token.
 */
export async function authenticateSuperAdminRequest(req: Request): Promise<SupportIdentity> {
  const cfg = loadConfig();
  assertAdminIpAllowed(req, cfg);

  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authenticatePlatformOperator(authHeader, true, "bearer");
  }

  const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
  const cookieToken = readCookieFromHeader(cookieHeader, ADMIN_SESSION_COOKIE_NAME);
  if (!cookieToken) {
    throw new AppError("UNAUTHENTICATED", "Platform operator authentication required.");
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method.toUpperCase())) {
    const csrfCookie = readCookieFromHeader(cookieHeader, ADMIN_CSRF_COOKIE_NAME);
    const csrfHeaderRaw = req.headers["x-admin-csrf"];
    const csrfHeader = Array.isArray(csrfHeaderRaw) ? csrfHeaderRaw[0] : csrfHeaderRaw;
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      throw new AppError("FORBIDDEN", "Admin CSRF check failed: missing or mismatched X-Admin-Csrf token.");
    }
  }

  const oidcCookieIdentity = verifyAdminOidcSessionCookieToken(cookieToken, cfg);
  if (oidcCookieIdentity) {
    return oidcCookieIdentity;
  }

  return authenticatePlatformOperator(`Bearer ${cookieToken}`, true, "admin_cookie");
}

/**
 * Enforces recent step-up re-authentication within ADMIN_STEP_UP_WINDOW_SECONDS (default 300s).
 * Returns 401 UNAUTHENTICATED when step-up is missing or expired.
 */
export function assertStepUpRecent(admin: SupportIdentity, cfg: AppConfig = loadConfig()): void {
  if (!admin.mfaVerified) {
    throw new AppError("UNAUTHENTICATED", "MFA verification is required for platform admin actions.");
  }
  if (!admin.stepUpAt) {
    throw new AppError(
      "UNAUTHENTICATED",
      `Step-up re-authentication required (window: ${cfg.adminStepUpWindowSeconds}s). Re-authenticate before performing this destructive action.`
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - admin.stepUpAt;
  if (ageSec < -30 || ageSec > cfg.adminStepUpWindowSeconds) {
    throw new AppError(
      "UNAUTHENTICATED",
      `Step-up re-authentication expired (${ageSec}s > ${cfg.adminStepUpWindowSeconds}s window). Re-authenticate and retry.`
    );
  }
}

/** Masks external subject or email for privacy-preserving display in platform admin views. */
export function maskSubjectIdentifier(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "***";
  if (s.includes("@")) {
    const [local, domain] = s.split("@");
    const maskedLocal = local.length <= 2 ? `${local[0] || "*"}***` : `${local.slice(0, 2)}***`;
    const parts = (domain || "").split(".");
    const tld = parts.length > 1 ? `.${parts[parts.length - 1]}` : "";
    const host = parts[0] || "";
    const maskedHost = host.length <= 1 ? "*" : `${host[0]}***`;
    return `${maskedLocal}@${maskedHost}${tld}`;
  }
  if (s.includes("|")) {
    const [provider, id] = s.split("|", 2);
    const tail = id.length > 4 ? id.slice(-3) : "***";
    return `${provider}|***${tail}`;
  }
  if (s.length <= 4) return `${s[0]}***`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** Stable pseudonymous principal reference for cross-tenant admin views (never exposes raw customer subject). */
export function pseudonymizePrincipalRef(principalId: string, tenantId: string, cfg: AppConfig = loadConfig()): string {
  const digest = crypto
    .createHmac("sha256", cfg.pseudonymSecret)
    .update(`admin-psn:${tenantId}:${principalId}`)
    .digest("hex")
    .slice(0, 12);
  return `psn_${digest}`;
}

async function authenticatePlatformOperator(
  authHeader: string | null | undefined,
  requireSuperAdmin: boolean,
  sourceMethod: "bearer" | "admin_cookie"
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
    return validateSupportClaims(claims, requireSuperAdmin, "oidc");
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

  return validateSupportClaims(decoded, requireSuperAdmin, sourceMethod);
}
