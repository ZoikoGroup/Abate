// backend/src/platform/oidc.ts
// Asymmetric OIDC JWT/JWKS verification, PKCE S256 checks, and HttpOnly cookie session tokens.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { AppConfig, isDevTokenEnabled, loadConfig } from "./config";
import { AppError } from "./errors";
import { assertSafeOutboundUrl } from "./ssrf";

export const SESSION_COOKIE_NAME = "abate_session";
export const OIDC_ASYMMETRIC_ALGS: jwt.Algorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512"
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

interface JwkCacheEntry {
  fetchedAt: number;
  keys: Record<string, any>[];
}

const jwksCache = new Map<string, JwkCacheEntry>();

export function resetOidcKeyCache(): void {
  jwksCache.clear();
}

export function sessionAudience(cfg: AppConfig): string {
  return `${cfg.authAudience}:session`;
}

function deriveSessionKey(cfg: AppConfig): Buffer {
  return crypto.createHmac("sha256", cfg.authSecret).update("abate-oidc-session-v1").digest();
}

export interface SessionCookiePayload {
  tenantId: string;
  subject: string;
  role: string;
  authMethod: "oidc" | "dev";
}

export function createSessionCookieToken(
  payload: SessionCookiePayload,
  ttlSeconds = 3600,
  cfg: AppConfig = loadConfig()
): string {
  return jwt.sign(
    {
      sub: payload.subject,
      tenant_id: payload.tenantId,
      role: payload.role,
      auth_method: payload.authMethod,
      typ: "oidc_session"
    },
    deriveSessionKey(cfg),
    {
      algorithm: "HS256",
      issuer: cfg.authIssuer,
      audience: sessionAudience(cfg),
      expiresIn: Math.max(60, Math.min(ttlSeconds, 3600))
    }
  );
}

export function verifySessionCookieToken(token: string, cfg: AppConfig = loadConfig()): SessionCookiePayload {
  let decoded: any;
  try {
    decoded = jwt.verify(token, deriveSessionKey(cfg), {
      algorithms: ["HS256"],
      issuer: cfg.authIssuer,
      audience: sessionAudience(cfg)
    });
  } catch {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired session cookie.");
  }

  if (
    !decoded ||
    decoded.typ !== "oidc_session" ||
    decoded.scope === "platform-support" ||
    typeof decoded.sub !== "string" ||
    !decoded.sub ||
    typeof decoded.tenant_id !== "string" ||
    !UUID_REGEX.test(decoded.tenant_id)
  ) {
    throw new AppError("UNAUTHENTICATED", "Invalid session claims.");
  }

  if (!isDevTokenEnabled(cfg) && decoded.auth_method !== "oidc") {
    throw new AppError("UNAUTHENTICATED", "OIDC session required outside local and test.");
  }

  return {
    tenantId: decoded.tenant_id,
    subject: decoded.sub,
    role: typeof decoded.role === "string" && decoded.role ? decoded.role : "REVIEWER",
    authMethod: decoded.auth_method === "oidc" ? "oidc" : "dev"
  };
}

export function formatSessionCookie(token: string, maxAgeSeconds = 3600, cfg: AppConfig = loadConfig()): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (cfg.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function formatClearSessionCookie(cfg: AppConfig = loadConfig()): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0"
  ];
  if (cfg.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function readCookieFromHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function selectJwk(keys: Record<string, any>[], kid: string | undefined): Record<string, any> | undefined {
  const signingKeys = keys.filter(k => !k.use || k.use === "sig");
  if (kid) {
    return signingKeys.find(k => k.kid === kid);
  }
  return signingKeys.length === 1 ? signingKeys[0] : signingKeys[0];
}

function parseJwksDocument(rawJson: string): Record<string, any>[] {
  let doc: any;
  try {
    doc = JSON.parse(rawJson);
  } catch {
    throw new AppError("UNAUTHENTICATED", "OIDC JWKS configuration is malformed.");
  }
  if (!doc || !Array.isArray(doc.keys) || doc.keys.length === 0) {
    throw new AppError("UNAUTHENTICATED", "OIDC JWKS contains no verification keys.");
  }
  return doc.keys;
}

async function fetchJwksKeys(jwksUri: string, forceRefresh = false, cfg: AppConfig = loadConfig()): Promise<Record<string, any>[]> {
  try {
    assertSafeOutboundUrl(jwksUri, { cfg, allowLocalInDev: true, label: "OIDC JWKS URI" });
  } catch (err: any) {
    throw new AppError("UNAUTHENTICATED", err?.message || "Invalid OIDC JWKS URI configuration.");
  }

  const cached = jwksCache.get(jwksUri);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const res = await fetch(jwksUri, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    throw new AppError("UNAUTHENTICATED", "Failed to retrieve OIDC JWKS keys from identity provider.");
  }
  const text = await res.text();
  const keys = parseJwksDocument(text);
  jwksCache.set(jwksUri, { fetchedAt: Date.now(), keys });
  return keys;
}

async function resolveAsymmetricKey(kid: string | undefined, cfg: AppConfig): Promise<crypto.KeyObject> {
  if (cfg.oidcPublicKeyPem) {
    try {
      return crypto.createPublicKey(cfg.oidcPublicKeyPem);
    } catch {
      throw new AppError("UNAUTHENTICATED", "Configured OIDC public key could not be parsed.");
    }
  }

  if (cfg.oidcJwksJson) {
    const keys = parseJwksDocument(cfg.oidcJwksJson);
    const matched = selectJwk(keys, kid);
    if (!matched) {
      throw new AppError("UNAUTHENTICATED", "No matching signing key found in OIDC JWKS.");
    }
    try {
      return crypto.createPublicKey({ key: matched as any, format: "jwk" });
    } catch {
      throw new AppError("UNAUTHENTICATED", "Matched JWK could not be converted to a public key.");
    }
  }

  if (cfg.oidcJwksUri) {
    let keys = await fetchJwksKeys(cfg.oidcJwksUri, false, cfg);
    let matched = selectJwk(keys, kid);
    if (!matched && kid) {
      // Support seamless key rollover on unknown kid
      keys = await fetchJwksKeys(cfg.oidcJwksUri, true, cfg);
      matched = selectJwk(keys, kid);
    }
    if (!matched) {
      throw new AppError("UNAUTHENTICATED", "No matching signing key found in remote OIDC JWKS.");
    }
    try {
      return crypto.createPublicKey({ key: matched as any, format: "jwk" });
    } catch {
      throw new AppError("UNAUTHENTICATED", "Remote JWK could not be converted to a public key.");
    }
  }

  throw new AppError("UNAUTHENTICATED", "OIDC asymmetric verification keys are not configured.");
}

export async function verifyOidcJwt(
  token: string,
  options: { audience?: string; cfg?: AppConfig } = {}
): Promise<Record<string, any>> {
  const cfg = options.cfg ?? loadConfig();
  const complete = jwt.decode(token, { complete: true });
  if (!complete || typeof complete === "string" || !complete.header) {
    throw new AppError("UNAUTHENTICATED", "Malformed OIDC JWT.");
  }

  const alg = String(complete.header.alg || "");
  if (!OIDC_ASYMMETRIC_ALGS.includes(alg as jwt.Algorithm)) {
    throw new AppError("UNAUTHENTICATED", "Unsupported or insecure JWT signing algorithm for OIDC authentication.");
  }

  const keyObject = await resolveAsymmetricKey(
    typeof complete.header.kid === "string" ? complete.header.kid : undefined,
    cfg
  );

  try {
    const verified = jwt.verify(token, keyObject, {
      algorithms: [alg as jwt.Algorithm],
      issuer: cfg.authIssuer,
      audience: options.audience ?? cfg.authAudience
    });
    if (!verified || typeof verified === "string") {
      throw new Error("Invalid JWT payload");
    }
    return verified as Record<string, any>;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNAUTHENTICATED", "Invalid or expired OIDC token.");
  }
}

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (
    typeof codeVerifier !== "string" ||
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)
  ) {
    return false;
  }
  const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed, "utf-8");
  const b = Buffer.from(codeChallenge || "", "utf-8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeOidcAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  cfg?: AppConfig;
}): Promise<string> {
  const cfg = params.cfg ?? loadConfig();
  if (!cfg.oidcTokenEndpoint || !cfg.oidcClientId) {
    throw new AppError("VALIDATION", "OIDC token endpoint and client ID are not configured on this server.");
  }

  assertSafeOutboundUrl(cfg.oidcTokenEndpoint, { cfg, allowLocalInDev: true, label: "OIDC token endpoint" });

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.oidcClientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri
  });

  const res = await fetch(cfg.oidcTokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: form.toString(),
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    throw new AppError("UNAUTHENTICATED", "OIDC authorization code exchange failed.");
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new AppError("UNAUTHENTICATED", "OIDC token endpoint returned invalid JSON.");
  }

  const token = typeof data?.id_token === "string" && data.id_token
    ? data.id_token
    : typeof data?.access_token === "string" && data.access_token
      ? data.access_token
      : "";
  if (!token) {
    throw new AppError("UNAUTHENTICATED", "OIDC token response did not include an id_token or access_token.");
  }
  return token;
}

export function extractTenantClaimsFromOidc(
  claims: Record<string, any>,
  cfg: AppConfig = loadConfig()
): { tenantId: string; subject: string; role: string } {
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const rawTenant =
    claims[cfg.oidcTenantClaim] ??
    claims.tenant_id ??
    claims["https://abate.internal/tenant_id"];
  const tenantId = typeof rawTenant === "string" ? rawTenant : "";

  if (!subject || !tenantId || !UUID_REGEX.test(tenantId) || claims.scope === "platform-support") {
    throw new AppError("UNAUTHENTICATED", "OIDC token is missing valid subject or tenant claims.");
  }

  const rawRole = claims[cfg.oidcRoleClaim] ?? claims.role ?? (Array.isArray(claims.roles) ? claims.roles[0] : undefined);
  const role = typeof rawRole === "string" && rawRole ? rawRole : "REVIEWER";

  return { tenantId, subject, role };
}
