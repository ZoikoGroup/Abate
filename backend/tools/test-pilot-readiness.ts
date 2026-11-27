// backend/tools/test-pilot-readiness.ts
// Stage B Item 6 verification:
// Proves OIDC login (RS256 JWKS + key rotation + PKCE + HttpOnly abate_session cookie),
// dev token endpoints disabled (404 / 401), external secrets manager loading
// (ABATE_SECRETS_FILE / ABATE_SECRETS_DIR), durable S3 health readiness (503 when unreachable),
// B8-safe Prometheus /metrics, and /api/v2/ops/alerts evaluation without tenant/PII leakage.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import jwt from "jsonwebtoken";
import {
  assertRuntimeConfig,
  buildConfig,
  loadConfig,
  resetConfigCache,
  validateRuntimeConfig
} from "../src/platform/config";
import { resetOidcKeyCache, verifyPkceS256 } from "../src/platform/oidc";
import {
  evaluateOperationalAlerts,
  resetPrivacyCounters
} from "../src/platform/monitoring";
import { resetPgHealthCache } from "../src/platform/db/with-tenant";
import { telemetry } from "../src/platform/telemetry";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { app } from "../src/index";

console.log("\x1b[36m=== Abate Task Runner: test-pilot (Stage B Item 6 Pilot Readiness) ===\x1b[0m");

let passed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err?.stack || err?.message}`);
    process.exit(1);
  }
}

function callApp(
  method: string,
  urlPath: string,
  options: {
    token?: string;
    cookie?: string;
    idempotencyKey?: string;
    body?: any;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: any; rawBody: string; headers: Record<string, string | string[]> }> {
  return new Promise((resolve) => {
    const payloadStr = options.body !== undefined && options.body !== null
      ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body))
      : null;

    const reqHeaders: Record<string, string> = {
      accept: "application/json",
      ...(options.headers ? Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v])) : {})
    };
    if (payloadStr !== null) {
      reqHeaders["content-type"] = "application/json";
      reqHeaders["content-length"] = Buffer.byteLength(payloadStr).toString();
    }
    if (options.token) reqHeaders["authorization"] = `Bearer ${options.token}`;
    if (options.cookie) reqHeaders["cookie"] = options.cookie;
    if (options.idempotencyKey) reqHeaders["idempotency-key"] = options.idempotencyKey;

    const req = new http.IncomingMessage(new PassThrough() as unknown as Socket);
    req.method = method.toUpperCase();
    req.url = urlPath;
    req.headers = reqHeaders;
    if (payloadStr) req.push(payloadStr);
    req.push(null);

    const socket = new PassThrough();
    const res = new http.ServerResponse(req);
    res.assignSocket(socket as unknown as Socket);

    const resChunks: Buffer[] = [];
    socket.on("data", (chunk) => resChunks.push(chunk));
    res.on("finish", () => {
      const raw = Buffer.concat(resChunks).toString("utf8");
      const parts = raw.split("\r\n\r\n");
      const rawBody = parts.slice(1).join("\r\n\r\n");
      let body: any = rawBody || null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        // leave plain text (e.g. Prometheus /metrics) in body/rawBody
      }
      const headersOut: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v !== undefined) headersOut[k.toLowerCase()] = v as any;
      }
      resolve({ status: res.statusCode || 200, body, rawBody, headers: headersOut });
    });

    app(req, res);
  });
}

function generateRsaJwkPair(kid: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  const pubJwk = crypto.createPublicKey(publicKey).export({ format: "jwk" }) as Record<string, any>;
  pubJwk.kid = kid;
  pubJwk.use = "sig";
  pubJwk.alg = "RS256";
  return { kid, publicKey, privateKey, pubJwk };
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abate-pilot-"));
  const originalFetch = globalThis.fetch;
  const savedEnv = { ...process.env };

  try {
    await seedTwoTenants({ clock: new Date("2026-03-02T09:00:00.000Z") });

    // 1. Secret Manager loading (JSON bundle + directory mounts)
    await check("Secrets Manager: ABATE_SECRETS_FILE and ABATE_SECRETS_DIR hydrate production config safely", () => {
      const secretsFile = path.join(tmpDir, "abate-secrets.json");
      const secretsPayload = {
        APP_ENV: "production",
        CLIENT_URL: "https://abate.pilot.example",
        AUTH_ISSUER: "https://idp.pilot.example/",
        AUTH_AUDIENCE: "abate-api",
        AUTH_SECRET: "a".repeat(40),
        SUPPORT_AUTH_SECRET: "b".repeat(40),
        ACTION_GRANT_SECRET: "c".repeat(40),
        PSEUDONYM_SECRET: "e".repeat(40),
        OBJECT_STORE_SECRET_KEY: "d".repeat(40),
        OBJECT_STORE_ACCESS_KEY: "AKIA_PILOT_SECRET_MANAGER",
        OBJECT_STORE_ENDPOINT: "https://s3.eu-west-2.amazonaws.com",
        DATABASE_URL_MIGRATOR: "postgres://m:x@pg.internal:5432/abate",
        DATABASE_URL_APP: "postgres://a:x@pg.internal:5432/abate",
        DATABASE_URL_WORKER: "postgres://w:x@pg.internal:5432/abate",
        DATABASE_URL_PLATFORM_ADMIN: "postgres://pa:x@pg.internal:5432/abate",
        ABATE_REQUIRE_PG: "1",
        OIDC_JWKS_URI: "https://idp.pilot.example/.well-known/jwks.json"
      };
      fs.writeFileSync(secretsFile, JSON.stringify(secretsPayload), "utf-8");

      const fileEnv: NodeJS.ProcessEnv = { APP_ENV: "production", ABATE_SECRETS_FILE: secretsFile };
      const cfgFromFile = buildConfig(fileEnv);
      assert.deepStrictEqual(validateRuntimeConfig(cfgFromFile, fileEnv), []);
      assert.doesNotThrow(() => assertRuntimeConfig(cfgFromFile, fileEnv));
      assert.strictEqual(cfgFromFile.disableDevToken, true);
      assert.strictEqual(cfgFromFile.cookieSecure, true);
      assert.strictEqual(cfgFromFile.structuredLogs, true);

      const secretsDir = path.join(tmpDir, "run-secrets");
      fs.mkdirSync(secretsDir);
      for (const [k, v] of Object.entries(secretsPayload)) {
        fs.writeFileSync(path.join(secretsDir, k), `${String(v)}\n`, "utf-8");
      }
      const dirEnv: NodeJS.ProcessEnv = { APP_ENV: "production", ABATE_SECRETS_DIR: secretsDir };
      const cfgFromDir = buildConfig(dirEnv);
      assert.deepStrictEqual(validateRuntimeConfig(cfgFromDir, dirEnv), []);

      // Corrupt secret file fails closed without echoing raw content
      const badFile = path.join(tmpDir, "bad-secrets.json");
      fs.writeFileSync(badFile, "SUPER_SECRET_SHOULD_NEVER_LEAK", "utf-8");
      const badEnv: NodeJS.ProcessEnv = { APP_ENV: "production", ABATE_SECRETS_FILE: badFile };
      const problems = validateRuntimeConfig(buildConfig(badEnv), badEnv).join(" | ");
      assert.ok(problems.includes("ABATE_SECRETS_FILE"));
      assert.ok(!problems.includes("SUPER_SECRET_SHOULD_NEVER_LEAK"));
    });

    // 2. Enable OIDC-only Pilot mode (dev token endpoint OFF)
    const key1 = generateRsaJwkPair("pilot-key-1");
    const key2 = generateRsaJwkPair("pilot-key-2");
    let exposeKey2InJwks = false;

    const codeVerifier = "pilot_verifier_abcdefghijklmnopqrstuvwxyz_0123456789_ABCDEF";
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    assert.ok(verifyPkceS256(codeVerifier, codeChallenge));

    const pilotCfg = loadConfig();
    const rs256TenantJwt = jwt.sign(
      {
        sub: "auth0|user-tenant-a-risk-owner",
        tenant_id: GOLDEN_01.tenantA.id,
        role: "RISK_OWNER"
      },
      key1.privateKey,
      {
        algorithm: "RS256",
        keyid: key1.kid,
        issuer: pilotCfg.authIssuer,
        audience: pilotCfg.authAudience,
        expiresIn: "15m"
      }
    );

    const rs256RotatedJwt = jwt.sign(
      {
        sub: "auth0|user-tenant-a-risk-owner",
        tenant_id: GOLDEN_01.tenantA.id,
        role: "RISK_OWNER"
      },
      key2.privateKey,
      {
        algorithm: "RS256",
        keyid: key2.kid,
        issuer: pilotCfg.authIssuer,
        audience: pilotCfg.authAudience,
        expiresIn: "15m"
      }
    );

    const rs256SupportJwt = jwt.sign(
      {
        sub: "ops.pilot-oncall",
        scope: "platform-support"
      },
      key1.privateKey,
      {
        algorithm: "RS256",
        keyid: key1.kid,
        issuer: pilotCfg.authIssuer,
        audience: `${pilotCfg.authAudience}:support`,
        expiresIn: "15m"
      }
    );

    let capturedTokenBody = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr === "https://idp.pilot.test/.well-known/jwks.json") {
        const keys = exposeKey2InJwks ? [key1.pubJwk, key2.pubJwk] : [key1.pubJwk];
        return new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (urlStr === "https://idp.pilot.test/oauth/token") {
        capturedTokenBody = String(init?.body || "");
        return new Response(JSON.stringify({ id_token: rs256TenantJwt, token_type: "Bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return originalFetch(input as any, init);
    }) as typeof fetch;

    process.env.ABATE_DISABLE_DEV_TOKEN = "1";
    process.env.OIDC_JWKS_URI = "https://idp.pilot.test/.well-known/jwks.json";
    process.env.OIDC_AUTHORIZATION_ENDPOINT = "https://idp.pilot.test/authorize";
    process.env.OIDC_TOKEN_ENDPOINT = "https://idp.pilot.test/oauth/token";
    process.env.OIDC_CLIENT_ID = "abate-pilot-web";
    process.env.METRICS_AUTH_TOKEN = "pilot-metrics-scrape-token-32chars!!";
    resetConfigCache();
    resetOidcKeyCache();
    resetPrivacyCounters();

    // Mint an HS256 dev token manually with dev secret to verify rejection when disabled
    const hs256DevJwt = jwt.sign(
      {
        sub: "auth0|user-tenant-a-risk-owner",
        tenant_id: GOLDEN_01.tenantA.id,
        role: "RISK_OWNER"
      },
      loadConfig().authSecret,
      { algorithm: "HS256", issuer: pilotCfg.authIssuer, audience: pilotCfg.authAudience, expiresIn: "1h" }
    );

    await check("Dev Token Lockdown: /token, /refresh, /support-token return 404 and HS256 dev tokens fail closed", async () => {
      const tRes = await callApp("POST", "/api/v2/auth/token", {
        body: { tenantId: GOLDEN_01.tenantA.id, subject: "auth0|user-tenant-a-risk-owner", role: "RISK_OWNER" }
      });
      assert.strictEqual(tRes.status, 404);

      const rRes = await callApp("POST", "/api/v2/auth/refresh", { token: rs256TenantJwt });
      assert.strictEqual(rRes.status, 404);

      const sRes = await callApp("POST", "/api/v2/auth/support-token", { body: { operator: "ops.test" } });
      assert.strictEqual(sRes.status, 404);

      assert.throws(
        () => createDevToken({ tenantId: GOLDEN_01.tenantA.id, subject: "auth0|user-tenant-a-risk-owner" }),
        (err: any) => err.code === "NOT_FOUND"
      );

      // Symmetric dev token rejected on tenant API
      const hsTry = await callApp("GET", "/api/v2/me", { token: hs256DevJwt });
      assert.strictEqual(hsTry.status, 401);

      // alg: none unsigned token rejected
      const unsignedHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const unsignedBody = Buffer.from(JSON.stringify({
        sub: "auth0|user-tenant-a-risk-owner",
        tenant_id: GOLDEN_01.tenantA.id,
        iss: pilotCfg.authIssuer,
        aud: pilotCfg.authAudience
      })).toString("base64url");
      const noneTry = await callApp("GET", "/api/v2/me", { token: `${unsignedHeader}.${unsignedBody}.` });
      assert.strictEqual(noneTry.status, 401);
    });

    await check("OIDC Config, RS256 JWKS Authentication & Key Rotation work with dev tokens OFF", async () => {
      const cfgRes = await callApp("GET", "/api/v2/auth/oidc/config");
      assert.strictEqual(cfgRes.status, 200);
      assert.strictEqual(cfgRes.body.devTokenEnabled, false);
      assert.strictEqual(cfgRes.body.oidcConfigured, true);
      assert.strictEqual(cfgRes.body.pkceMethod, "S256");

      const meRes = await callApp("GET", "/api/v2/me", { token: rs256TenantJwt });
      assert.strictEqual(meRes.status, 200);
      assert.strictEqual(meRes.body.tenantId, GOLDEN_01.tenantA.id);

      // Unknown kid before rotation fails closed
      const preRot = await callApp("GET", "/api/v2/organizations", { token: rs256RotatedJwt });
      assert.strictEqual(preRot.status, 401);

      // Rotate key in JWKS -> automatic JWKS refresh accepts key2 cleanly
      exposeKey2InJwks = true;
      const postRot = await callApp("GET", "/api/v2/organizations", { token: rs256RotatedJwt });
      assert.strictEqual(postRot.status, 200);
    });

    let sessionCookiePair = "";
    await check("OIDC PKCE + Authorization Code Exchange issues HttpOnly cookie and honors B8 ops isolation", async () => {
      const badPkce = await callApp("POST", "/api/v2/auth/oidc/exchange", {
        body: { idToken: rs256TenantJwt, codeChallenge, codeVerifier: "wrong_verifier_abcdefghijklmnopqrstuvwxyz_0123456" }
      });
      assert.strictEqual(badPkce.status, 401);

      const exRes = await callApp("POST", "/api/v2/auth/oidc/exchange", {
        body: {
          code: "auth-code-pilot-001",
          codeVerifier,
          codeChallenge,
          redirectUri: "https://abate.pilot.example"
        }
      });
      assert.strictEqual(exRes.status, 200);
      assert.strictEqual(exRes.body.authenticated, true);
      assert.strictEqual(exRes.body.tenantId, GOLDEN_01.tenantA.id);
      assert.ok(capturedTokenBody.includes("grant_type=authorization_code"));
      assert.ok(capturedTokenBody.includes("client_id=abate-pilot-web"));

      const rawSetCookie = exRes.headers["set-cookie"];
      const cookieLine = Array.isArray(rawSetCookie) ? rawSetCookie[0] : String(rawSetCookie || "");
      assert.ok(cookieLine.includes("abate_session="));
      assert.ok(cookieLine.includes("HttpOnly"));
      assert.ok(cookieLine.includes("SameSite=Lax"));
      sessionCookiePair = cookieLine.split(";")[0]!;

      // Cookie authenticates tenant routes without any Authorization Bearer header
      const cookieMe = await callApp("GET", "/api/v2/me", { cookie: sessionCookiePair });
      assert.strictEqual(cookieMe.status, 200);
      assert.strictEqual(cookieMe.body.tenantId, GOLDEN_01.tenantA.id);

      const cookieOrgs = await callApp("GET", "/api/v2/organizations", { cookie: sessionCookiePair });
      assert.strictEqual(cookieOrgs.status, 200);

      // Cookie cannot cross B8 boundary onto /api/v2/ops/*
      const opsAttempt = await callApp("GET", "/api/v2/ops/alerts", { cookie: sessionCookiePair });
      assert.strictEqual(opsAttempt.status, 401);

      // Logout clears the session cookie
      const logoutRes = await callApp("POST", "/api/v2/auth/logout");
      assert.strictEqual(logoutRes.status, 204);
      const clearedCookie = String(Array.isArray(logoutRes.headers["set-cookie"]) ? logoutRes.headers["set-cookie"][0] : logoutRes.headers["set-cookie"] || "");
      assert.ok(clearedCookie.includes("Max-Age=0"));
    });

    await check("Monitoring, Privacy-Safe Prometheus /metrics, /api/v2/ops/alerts & S3 Health Check", async () => {
      // Trigger normal k-anonymity floor suppression (n<10): must NOT count as a privacy engine error
      const relRes = await callApp("POST", "/api/v2/releases/query", {
        cookie: sessionCookiePair,
        body: { query: { releaseClass: "CLASS_B" }, customCohortMembers: ["p-1", "p-2", "p-3"] }
      });
      assert.strictEqual(relRes.status, 200);
      assert.strictEqual(relRes.body.code, "NOT_AVAILABLE");

      // /metrics requires METRICS_AUTH_TOKEN when set
      const unauthMetrics = await callApp("GET", "/metrics");
      assert.strictEqual(unauthMetrics.status, 401);

      const metricsRes = await callApp("GET", "/metrics", { token: "pilot-metrics-scrape-token-32chars!!" });
      assert.strictEqual(metricsRes.status, 200);
      assert.ok(String(metricsRes.headers["content-type"]).includes("text/plain"));
      assert.ok(metricsRes.rawBody.includes("abate_privacy_suppressed_total 1"));
      assert.ok(metricsRes.rawBody.includes("abate_privacy_engine_errors_total 0"));
      assert.ok(metricsRes.rawBody.includes("abate_http_requests_total"));
      assert.ok(metricsRes.rawBody.includes("abate_worker_queue_depth"));
      assert.ok(metricsRes.rawBody.includes("abate_dependencies_up"));
      // B8 guarantee: never leak tenant UUID or subject into metrics output
      assert.ok(!metricsRes.rawBody.includes(GOLDEN_01.tenantA.id));
      assert.ok(!metricsRes.rawBody.includes("auth0|"));

      // Support OIDC JWT reaches /api/v2/ops/alerts, and normal suppression does NOT fire alerts
      const opsAlerts = await callApp("GET", "/api/v2/ops/alerts", { token: rs256SupportJwt });
      assert.strictEqual(opsAlerts.status, 200);
      assert.strictEqual(opsAlerts.body.overallStatus, "OK");
      assert.strictEqual(opsAlerts.body.summary.firingCount, 0);

      // Support OIDC token still cannot access tenant routes (B8)
      const supTenantAttempt = await callApp("GET", "/api/v2/organizations", { token: rs256SupportJwt });
      assert.strictEqual(supTenantAttempt.status, 401);

      // S3 unreachable / DB required down -> /api/health returns 503 degraded
      process.env.OBJECT_STORE_MODE = "s3";
      process.env.OBJECT_STORE_ENDPOINT = "http://127.0.0.1:9";
      resetConfigCache();
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED S3");
      }) as typeof fetch;

      const degradedHealth = await callApp("GET", "/api/health");
      assert.strictEqual(degradedHealth.status, 503);
      assert.strictEqual(degradedHealth.body.status, "degraded");
      assert.strictEqual(degradedHealth.body.objectStore.ok, false);

      // Alert evaluator unit check fires critical alerts on dead letters, dependency loss, and engine error
      telemetry.record({
        requestId: "req-fault-1",
        at: new Date().toISOString(),
        method: "GET",
        route: "/api/v2/organizations",
        routeClass: "READ",
        status: 500,
        durationMs: 1800,
        errorCode: "INTERNAL",
        errorFingerprint: "deadbeef12345678"
      });
      const firingReport = evaluateOperationalAlerts({
        cfg: loadConfig(),
        sloReport: {
          latency: [{ routeClass: "READ", requests: 10, p95Ms: 1800, targetP95Ms: 500, status: "BREACH" }],
          availability: { requests: 10, serverErrors: 2, ratio: 0.8, target: 0.999, status: "BREACH" }
        },
        workerMetrics: { state: "RUNNING", queueDepth: 12, queueLagMs: 75_000, totalProcessed: 5, totalFailures: 2, totalDeadLetters: 1 },
        deps: { databaseOk: false, databaseRequired: true, objectStoreOk: false, objectStoreMode: "s3" }
      });
      assert.strictEqual(firingReport.overallStatus, "FIRING");
      assert.ok(firingReport.alerts.some(a => a.id === "AbateDatabaseUnavailable" && a.state === "FIRING"));
      assert.ok(firingReport.alerts.some(a => a.id === "AbateObjectStoreUnavailable" && a.state === "FIRING"));
      assert.ok(firingReport.alerts.some(a => a.id === "AbateWorkerDeadLettersPresent" && a.state === "FIRING"));
    });

    console.log(`\n\x1b[32m[SUCCESS] ${passed} pilot readiness gates verified (dev tokens OFF, OIDC/JWKS/PKCE/cookie ON, secrets manager & monitoring active).\x1b[0m`);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    resetConfigCache();
    resetOidcKeyCache();
    resetPgHealthCache();
    resetPrivacyCounters();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error("[test-pilot] Fatal error:", err);
  process.exit(1);
});
