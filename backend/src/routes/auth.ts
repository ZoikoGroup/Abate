// backend/src/routes/auth.ts
import type { Express, Request, Response } from "express";
import { loadConfig, isDevTokenEnabled } from "../platform/config";
import {
  verifyOidcJwt,
  extractTenantClaimsFromOidc,
  verifyPkceS256,
  exchangeOidcAuthorizationCode,
  createSessionCookieToken,
  formatSessionCookie,
  formatClearSessionCookie
} from "../platform/oidc";
import { toErrorResponse, AppError } from "../platform/errors";
import { TokenRequestBody } from "../contracts";
import { authenticate, resolveActor, createDevToken, computeAllowedActions } from "../domains/tenant/auth";
import { formatClearAdminSessionCookies } from "../domains/support";
import { getTenant } from "../domains/tenant/commands";
import { withTenant } from "../platform/db/with-tenant";
import { resolveTenantSectorProfile, describeSectorScope } from "../domains/lifecycle";
import { getHeader } from "./helpers";

export function registerAuthRoutes(app: Express): void {
  // -------------------------------------------------------------
  // Authentication Endpoints (/api/v2/auth)
  // -------------------------------------------------------------

  // Dev-only issuance (like /auth/support-token): minting tokens for arbitrary tenant/subject/role must never be reachable in staging/production
  app.post("/api/v2/auth/token", (req: Request, res: Response) => {
    try {
      if (!isDevTokenEnabled(loadConfig())) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      const body = TokenRequestBody.parse(req.body);
      const token = createDevToken(body);
      res.status(200).json({
        token,
        tokenType: "Bearer",
        expiresIn: "8h",
        tenantId: body.tenantId,
        subject: body.subject,
        role: body.role
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Refresh dev authentication token (disabled alongside /api/v2/auth/token outside local/test)
  app.post("/api/v2/auth/refresh", async (req: Request, res: Response) => {
    try {
      if (!isDevTokenEnabled(loadConfig())) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      const who = await authenticate(getHeader(req, "authorization"));
      await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const token = createDevToken({
        tenantId: who.tenantId,
        subject: who.subject,
        role: who.role,
        purpose: who.purpose
      });
      res.status(200).json({
        token,
        tokenType: "Bearer",
        expiresIn: "8h",
        tenantId: who.tenantId,
        subject: who.subject,
        role: who.role
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Public OIDC discovery metadata (non-secret) so frontend knows whether to render OIDC login
  app.get("/api/v2/auth/oidc/config", (_req: Request, res: Response) => {
    const runtimeCfg = loadConfig();
    res.status(200).json({
      devTokenEnabled: isDevTokenEnabled(runtimeCfg),
      oidcConfigured: Boolean(runtimeCfg.oidcJwksUri || runtimeCfg.oidcJwksJson || runtimeCfg.oidcPublicKeyPem),
      authorizationEndpoint: runtimeCfg.oidcAuthorizationEndpoint || null,
      clientId: runtimeCfg.oidcClientId || null,
      issuer: runtimeCfg.authIssuer,
      audience: runtimeCfg.authAudience,
      scope: "openid profile email",
      pkceRequired: true,
      pkceMethod: "S256"
    });
  });

  // Exchange OIDC PKCE authorization code or verified OIDC JWT into an HttpOnly abate_session cookie
  app.post("/api/v2/auth/oidc/exchange", async (req: Request, res: Response) => {
    try {
      const runtimeCfg = loadConfig();
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const code = typeof body.code === "string" ? body.code : "";
      const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";
      const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : runtimeCfg.clientUrl;
      const codeChallenge = typeof body.codeChallenge === "string" ? body.codeChallenge : "";
      const directJwt = typeof body.idToken === "string"
        ? body.idToken
        : typeof body.token === "string"
          ? body.token
          : "";

      if (codeChallenge && (!codeVerifier || !verifyPkceS256(codeVerifier, codeChallenge))) {
        throw new AppError("UNAUTHENTICATED", "PKCE verification failed.");
      }

      let rawOidcJwt = directJwt;
      if (code) {
        if (!codeVerifier) {
          throw new AppError("VALIDATION", "PKCE codeVerifier is required for authorization code exchange.");
        }
        rawOidcJwt = await exchangeOidcAuthorizationCode({
          code,
          codeVerifier,
          redirectUri,
          cfg: runtimeCfg
        });
      }

      if (!rawOidcJwt) {
        throw new AppError("VALIDATION", "Provide an OIDC authorization code + codeVerifier or an OIDC JWT.");
      }

      const claims = await verifyOidcJwt(rawOidcJwt, { cfg: runtimeCfg });
      const identity = extractTenantClaimsFromOidc(claims, runtimeCfg);
      const remainingSec = typeof claims.exp === "number"
        ? Math.max(60, Math.min(3600, Math.floor(claims.exp - Date.now() / 1000)))
        : 3600;

      const sessionJwt = createSessionCookieToken(
        {
          tenantId: identity.tenantId,
          subject: identity.subject,
          role: identity.role,
          authMethod: "oidc"
        },
        remainingSec,
        runtimeCfg
      );

      res.setHeader("Set-Cookie", formatSessionCookie(sessionJwt, remainingSec, runtimeCfg));
      res.status(200).json({
        authenticated: true,
        tenantId: identity.tenantId,
        subject: identity.subject,
        role: identity.role,
        expiresIn: `${remainingSec}s`,
        authMethod: "oidc"
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Terminate session and clear HttpOnly OIDC cookie + dedicated admin cookies
  app.post("/api/v2/auth/logout", (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.setHeader("Set-Cookie", [
      formatClearSessionCookie(cfg),
      ...formatClearAdminSessionCookies(cfg)
    ]);
    res.status(204).send();
  });

  // Principal Profile, Server-Driven Allowed Navigations & Allowed Actions (Guide §D.1 / §F.1 / Completion Plan §7.1)
  app.get("/api/v2/me", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const tenant = await getTenant({ who, actor });
      const sectorProfile = await withTenant(who.tenantId, async (tx) => resolveTenantSectorProfile(tx, who.tenantId));

      const effectiveRoles = new Set<string>([
        ...(who.role ? [who.role] : []),
        ...actor.memberships.map((m: any) => String(m.domain_role))
      ]);
      const isReadOnlyRole =
        !effectiveRoles.has("RISK_OWNER") &&
        !effectiveRoles.has("EMPLOYER_ADMIN") &&
        !effectiveRoles.has("APPROVER") &&
        !effectiveRoles.has("REVIEWER") &&
        !effectiveRoles.has("IMPLEMENTATION_OWNER") &&
        !effectiveRoles.has("DPO") &&
        !effectiveRoles.has("PRIVACY_OFFICER") &&
        (effectiveRoles.has("VIEWER") || effectiveRoles.has("WORKER_REP") || effectiveRoles.has("EMPLOYEE") || effectiveRoles.has("MEMBER"));

      const allowedActions = computeAllowedActions(actor, who.role, who.purpose);

      const allowedNav: string[] = [
        "DASHBOARD",
        "ORGANIZATIONS",
        "COHORT_ANALYTICS",
        "HAZARD_CONTROL",
        "AUDIT",
        "VERIFIER",
        "CONSTITUTIONAL"
      ];

      if (sectorProfile.sectorKey !== "GENERIC") {
        allowedNav.push("SECTOR_PACK");
        if (sectorProfile.sectorKey === "LEGAL") {
          // deprecated alias of SECTOR_PACK, kept for one release for older clients
          allowedNav.push("LEGAL_PRACTICE");
        }
      }

      if (!isReadOnlyRole) {
        allowedNav.push("INGESTION", "RETENTION", "BOUNDED_AI", "OUTCOMES", "ISOLATION", "OUTBOX", "OPS");
      }

      if (
        allowedActions.includes("tenant.users.manage") ||
        allowedActions.includes("tenant.users.read") ||
        effectiveRoles.has("EMPLOYER_ADMIN")
      ) {
        allowedNav.push("TENANT_ADMIN");
      }

      res.status(200).json({
        principalId: actor.principalId,
        tenantId: who.tenantId,
        tenantName: tenant.name,
        subject: who.subject,
        purpose: who.purpose,
        role: who.role,
        memberships: actor.memberships.map((m: any) => ({
          organizationId: m.organization_id,
          domainRole: m.domain_role
        })),
        allowedNav,
        allowedActions
      });
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // -------------------------------------------------------------
  // Domain S01: Tenancy and Organization Endpoints (/api/v2)
}
