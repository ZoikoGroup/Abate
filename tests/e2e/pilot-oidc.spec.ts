// tests/e2e/pilot-oidc.spec.ts
// Stage B Item 6 Browser E2E Verification:
// Launches a real hardened backend (ABATE_DISABLE_DEV_TOKEN=1 + RS256 OIDC public key)
// and Vite frontend proxy on isolated ports, proving:
//   1. Dev token endpoints (/api/v2/auth/token, /api/v2/auth/support-token) return 404.
//   2. UI hides dev tenant/role pickers & Live Demo Console and renders the OIDC Sign-In gate.
//   3. Exchanging a real RS256-signed OIDC JWT issues an HttpOnly abate_session cookie and loads workspaces.
//   4. Signing out clears the HttpOnly session cookie (204) and returns to the OIDC Sign-In gate.

import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const BACKEND_PORT = 5059;
const FRONTEND_PORT = 5179;
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
const TENANT_A_ID = "00000000-0000-4000-a000-00000000000a";
const ISSUER = "http://localhost:5000/auth";
const AUDIENCE = "abate-api";

function b64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signRs256Jwt(payload: Record<string, unknown>, privateKeyPem: string): string {
  const header = b64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64Url(sig)}`;
}

async function waitForHttpReady(url: string, timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry until timeout
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test.describe("Stage B Item 6: Hardened OIDC Session Login & Dev Token Lockdown E2E", () => {
  test("locks down dev tokens (404), authenticates via RS256 OIDC -> HttpOnly cookie, and signs out cleanly", async ({
    page,
    context
  }) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    const repoRoot = path.resolve(__dirname, "../..");
    const backendDir = path.join(repoRoot, "backend");
    const frontendDir = path.join(repoRoot, "frontend");
    const tsxCli = path.join(backendDir, "node_modules/tsx/dist/cli.mjs");
    const viteCli = path.join(frontendDir, "node_modules/vite/bin/vite.js");

    let backendProc: ChildProcess | null = null;
    let frontendProc: ChildProcess | null = null;

    try {
      backendProc = spawn(process.execPath, [tsxCli, "src/index.ts"], {
        cwd: backendDir,
        stdio: "pipe",
        env: {
          ...process.env,
          APP_ENV: "test",
          ABATE_REQUIRE_PG: "0",
          DATABASE_URL_MIGRATOR: "postgres://disabled:disabled@127.0.0.1:1/abate",
          DATABASE_URL_APP: "postgres://disabled:disabled@127.0.0.1:1/abate",
          DATABASE_URL_WORKER: "postgres://disabled:disabled@127.0.0.1:1/abate",
          ABATE_DISABLE_DEV_TOKEN: "1",
          PORT: String(BACKEND_PORT),
          CLIENT_URL: FRONTEND_URL,
          OIDC_PUBLIC_KEY_PEM: publicKey,
          AUTH_ISSUER: ISSUER,
          AUTH_AUDIENCE: AUDIENCE,
          AUTH_SECRET: "pilot_e2e_auth_secret_key_abate_minimum_32_characters",
          SUPPORT_AUTH_SECRET: "pilot_e2e_support_secret_abate_minimum_32_characters",
          ACTION_GRANT_SECRET: "pilot_e2e_action_grant_abate_minimum_32_characters"
        }
      });

      await waitForHttpReady(`http://127.0.0.1:${BACKEND_PORT}/api/health`);

      frontendProc = spawn(
        process.execPath,
        [viteCli, "--host", "127.0.0.1", "--port", String(FRONTEND_PORT), "--strictPort"],
        {
          cwd: frontendDir,
          stdio: "pipe",
          env: {
            ...process.env,
            VITE_API_TARGET: `http://127.0.0.1:${BACKEND_PORT}`,
            VITE_PORT: String(FRONTEND_PORT)
          }
        }
      );

      await waitForHttpReady(FRONTEND_URL);

      // 1. Verify dev token & support token routes return 404 when disabled
      const devTokRes = await page.request.post(`${FRONTEND_URL}/api/v2/auth/token`, {
        data: { tenantId: TENANT_A_ID, subject: "auth0|user-tenant-a-risk-owner", role: "RISK_OWNER" }
      });
      expect(devTokRes.status()).toBe(404);

      const supTokRes = await page.request.post(`${FRONTEND_URL}/api/v2/auth/support-token`, {
        data: { operator: "attacker" }
      });
      expect(supTokRes.status()).toBe(404);

      const oidcCfgRes = await page.request.get(`${FRONTEND_URL}/api/v2/auth/oidc/config`);
      expect(oidcCfgRes.status()).toBe(200);
      const oidcCfg = await oidcCfgRes.json();
      expect(oidcCfg.devTokenEnabled).toBe(false);
      expect(oidcCfg.oidcConfigured).toBe(true);

      // 2. Visit frontend and assert OIDC gate renders with dev controls removed
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("heading", { name: /Sign in with your Identity Provider/i })).toBeVisible({
        timeout: 15_000
      });
      await expect(page.locator("#tenant-select")).toHaveCount(0);
      await expect(page.locator("#role-select")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Launch Guided Live Demo Console/i })).toHaveCount(0);

      // 3. Sign a real RS256 OIDC JWT and exchange it for an HttpOnly abate_session cookie
      const nowSec = Math.floor(Date.now() / 1000);
      const oidcJwt = signRs256Jwt(
        {
          sub: "auth0|user-tenant-a-risk-owner",
          tenant_id: TENANT_A_ID,
          role: "RISK_OWNER",
          iss: ISSUER,
          aud: AUDIENCE,
          iat: nowSec,
          exp: nowSec + 600
        },
        privateKey
      );

      await page.locator("#oidc-jwt-input").fill(oidcJwt);
      const exResPromise = page.waitForResponse(
        (r) => r.url().includes("/api/v2/auth/oidc/exchange") && r.request().method() === "POST"
      );
      await page.getByRole("button", { name: /Exchange OIDC JWT for Session Cookie/i }).click();
      const exRes = await exResPromise;
      expect(exRes.status()).toBe(200);

      // Assert workspace loads using HttpOnly session cookie (no localStorage dev bearer)
      await expect(page.getByRole("button", { name: /Sign out of OIDC session/i })).toBeVisible({
        timeout: 10_000
      });
      await expect(page.getByText(/Active Tenant Organizations \(Apex Legal Partners/i)).toBeVisible({
        timeout: 10_000
      });

      // Production-clean nav in hardened OIDC mode: Dashboard present, dev attack labs hidden, no "(Phase N)" labels
      await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Tenant Isolation & Attack Lab/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Transactional Outbox/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /\(Phase \d\)/i })).toHaveCount(0);

      // Navigate to Dashboard and verify health + authorized workspace tiles render
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      await expect(page.getByRole("heading", { name: /Platform Dashboard/i })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Authorized Workspaces/i })).toBeVisible();

      // Navigate to Bounded AI & Actions and verify kill switches are read-only in hardened OIDC mode
      await page.getByRole("button", { name: "Bounded AI & Actions", exact: true }).click();
      await expect(page.getByText(/Read-only for tenant sessions/i).first()).toBeVisible();

      // Navigate to Operations & Support and sign in with a real RS256 Support OIDC JWT
      await page.getByRole("button", { name: "Operations & Support", exact: true }).click();
      await expect(page.locator("#ops-support-jwt")).toBeVisible();
      const supportOidcJwt = signRs256Jwt(
        {
          sub: "ops.pilot-oncall",
          scope: "platform-support",
          iss: ISSUER,
          aud: `${AUDIENCE}:support`,
          iat: nowSec,
          exp: nowSec + 600
        },
        privateKey
      );
      await page.locator("#ops-support-jwt").fill(supportOidcJwt);
      const sloPromise = page.waitForResponse((r) => r.url().includes("/api/v2/ops/slo") && r.request().method() === "GET");
      await page.getByRole("button", { name: /Connect with Support OIDC JWT/i }).click();
      expect((await sloPromise).status()).toBe(200);
      await expect(page.getByText(/Support OIDC session verified/i)).toBeVisible();

      const cookies = await context.cookies(FRONTEND_URL);
      const sessionCookie = cookies.find((c) => c.name === "abate_session");
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie?.httpOnly).toBe(true);

      // 4. Sign out and verify session termination returns to OIDC Sign-In screen
      const logoutPromise = page.waitForResponse(
        (r) => r.url().includes("/api/v2/auth/logout") && r.request().method() === "POST"
      );
      await page.getByRole("button", { name: /Sign out of OIDC session/i }).click();
      expect((await logoutPromise).status()).toBe(204);
      await expect(page.getByRole("heading", { name: /Sign in with your Identity Provider/i })).toBeVisible({
        timeout: 10_000
      });
    } finally {
      if (frontendProc && !frontendProc.killed) frontendProc.kill();
      if (backendProc && !backendProc.killed) backendProc.kill();
    }
  });
});
