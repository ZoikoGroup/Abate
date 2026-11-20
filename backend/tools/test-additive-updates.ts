// backend/tools/test-additive-updates.ts
// Verifies additive Completion Plan updates:
// 1. Durable async_job persistence & tenant isolation (0087_async_jobs_and_role_policies.sql)
// 2. Server-driven /api/v2/me allowedNav by role & active sector pack (§7.1)
// 3. Least-privilege withOps & withPerformance route wiring (§5.1)
// 4. Region-pinned, SSRF-guarded HttpModelProvider adapter behind ModelProvider (§6 / G-30)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { createSupportToken } from "../src/domains/support";
import { loadConfig } from "../src/platform/config";
import { HttpModelProvider } from "../src/domains/ai/providers/http-model-provider";
import { callModel, providers, registerConfiguredHttpProvider } from "../src/domains/ai/gateway";
import { DEFAULT_AI_USE_CASES } from "../src/domains/ai/run";
import { withTenant, isPostgresRequired } from "../src/platform/db/with-tenant";

let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err?.message || err}`);
    process.exit(1);
  }
}

async function reqJson(method: string, urlPath: string, opts?: { token?: string; headers?: Record<string, string>; body?: any }) {
  const res = await expressCall(method, urlPath, {
    token: opts?.token,
    headers: opts?.headers,
    body: opts?.body
  });
  return { status: res.status, json: res.body, headers: res.headers };
}

async function main() {
  console.log("\x1b[36m=== Abate Additive Updates Verification Suite (test-additive) ===\x1b[0m\n");

  const cfg = loadConfig();
  await seedTwoTenants({ clock: new Date(cfg.fixedClock), persistToPostgres: isPostgresRequired() });

  const tokenA = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });
  const tokenB = createDevToken({
    tenantId: GOLDEN_01.tenantB.id,
    subject: "auth0|user-tenant-b-risk-owner",
    role: "RISK_OWNER"
  });
  const supportToken = createSupportToken({ operator: "ops-additive-check" });

  await check("Migration 0087 declares async_job FORCE RLS, abate_performance read policies, and ops_active_tenants view", async () => {
      const migPath = path.resolve(__dirname, "../db/migrations/0087_async_jobs_and_role_policies.sql");
      const sql = fs.readFileSync(migPath, "utf8");
      assert.match(sql, /ALTER TABLE async_job ENABLE ROW LEVEL SECURITY/i);
      assert.match(sql, /ALTER TABLE async_job FORCE ROW LEVEL SECURITY/i);
      assert.match(sql, /CREATE POLICY async_job_tenant_isolation ON async_job/i);
      assert.match(sql, /CREATE POLICY outcome_definition_performance_read ON outcome_definition/i);
      assert.match(sql, /CREATE OR REPLACE VIEW ops_active_tenants/i);
      assert.match(sql, /GRANT SELECT ON ops_active_tenants TO abate_ops, abate_worker/i);
    });

    await check("Durable async_job: recalculation persists in async_job and enforces cross-tenant 404 isolation", async () => {
      const recalc = await reqJson("POST", "/api/v2/metrics/BOUNDARY_INTRUSION_SHARE/recalculate", {
        token: tokenA,
        body: {}
      });
      assert.strictEqual(recalc.status, 202);
      const jobId = recalc.json.jobId as string;
      assert.ok(jobId, "Recalculation must return a jobId");

      // Verify row exists in async_job via withTenant
      const persisted = await withTenant(GOLDEN_01.tenantA.id, async (tx) => {
        return await tx.q("SELECT id, job_type, state FROM async_job WHERE id = $1", [jobId]);
      });
      assert.strictEqual(persisted.rowCount, 1, "async_job must persist recalculation job");
      assert.strictEqual(persisted.rows[0].job_type, "METRIC_RECALCULATION");

      // Same tenant gets 200 COMPLETED
      const jobA = await reqJson("GET", `/api/v2/jobs/${jobId}`, { token: tokenA });
      assert.strictEqual(jobA.status, 200);
      assert.strictEqual(jobA.json.state, "COMPLETED");

      // Foreign tenant gets identical 404
      const jobB = await reqJson("GET", `/api/v2/jobs/${jobId}`, { token: tokenB });
      assert.strictEqual(jobB.status, 404);
    });

    await check("Dynamic /api/v2/me allowedNav reflects active sector pack (LEGAL vs GENERIC)", async () => {
      // Ensure LEGAL pack first
      await reqJson("PUT", "/api/v2/tenant/sector-profile", {
        token: tokenA,
        headers: { "Idempotency-Key": `add-legal-${Date.now()}` },
        body: { sectorKey: "LEGAL", packKey: "legal-uk-sra" }
      });

      const meLegal = await reqJson("GET", "/api/v2/me", { token: tokenA });
      assert.strictEqual(meLegal.status, 200);
      assert.ok(meLegal.json.allowedNav.includes("SECTOR_PACK"));
      assert.ok(meLegal.json.allowedNav.includes("LEGAL_PRACTICE"));
      assert.ok(meLegal.json.allowedNav.includes("OPS"));

      try {
        await reqJson("PUT", "/api/v2/tenant/sector-profile", {
          token: tokenA,
          headers: { "Idempotency-Key": `add-generic-${Date.now()}` },
          body: { sectorKey: "GENERIC", packKey: "generic-work-design" }
        });
        const meGeneric = await reqJson("GET", "/api/v2/me", { token: tokenA });
        assert.strictEqual(meGeneric.status, 200);
        assert.strictEqual(meGeneric.json.allowedNav.includes("SECTOR_PACK"), false, "GENERIC tenant must not receive SECTOR_PACK nav");
        assert.strictEqual(meGeneric.json.allowedNav.includes("LEGAL_PRACTICE"), false, "GENERIC tenant must not receive LEGAL_PRACTICE nav");
      } finally {
        await reqJson("PUT", "/api/v2/tenant/sector-profile", {
          token: tokenA,
          headers: { "Idempotency-Key": `add-restore-${Date.now()}` },
          body: { sectorKey: "LEGAL", packKey: "legal-uk-sra" }
        });
      }
    });

    await check("Dynamic /api/v2/me allowedNav narrows operational tabs for read-only MEMBER role", async () => {
      // Uses already-seeded ABATE-GOLDEN-01 cohort member (works identically on memDb and live PostgreSQL)
      const memberToken = createDevToken({
        tenantId: GOLDEN_01.tenantA.id,
        subject: "auth0|user-tenant-a-member-002",
        role: "MEMBER"
      });
      const meMember = await reqJson("GET", "/api/v2/me", { token: memberToken });
      assert.strictEqual(meMember.status, 200);
      assert.ok(meMember.json.allowedNav.includes("ORGANIZATIONS"));
      assert.ok(meMember.json.allowedNav.includes("COHORT_ANALYTICS"));
      assert.strictEqual(meMember.json.allowedNav.includes("OPS"), false, "MEMBER must not receive OPS nav");
      assert.strictEqual(meMember.json.allowedNav.includes("INGESTION"), false, "MEMBER must not receive INGESTION nav");
      assert.strictEqual(meMember.json.allowedNav.includes("BOUNDED_AI"), false, "MEMBER must not receive BOUNDED_AI nav");
    });

    await check("withOps & withPerformance routes operate end-to-end (kill-switches, ops/ai-quota, outcomes, ai-changes)", async () => {
      const ks = await reqJson("GET", "/api/v2/ops/kill-switches", { token: supportToken });
      assert.strictEqual(ks.status, 200);

      const quota = await reqJson("GET", "/api/v2/ops/ai-quota", { token: supportToken });
      assert.strictEqual(quota.status, 200);
      assert.ok(Array.isArray(quota.json.items) && quota.json.items.length >= 2);

      const evals = await reqJson("GET", "/api/v2/outcomes/evaluations", { token: tokenA });
      assert.strictEqual(evals.status, 200);

      const changes = await reqJson("GET", "/api/v2/ai-changes", { token: tokenA });
      assert.strictEqual(changes.status, 200);
    });

    await check("HttpModelProvider enforces SSRF protection, region pinning, JSON decoding, and keeps zoiko-mock intact", async () => {
      assert.ok(providers["zoiko-mock"], "DeterministicMockProvider must remain registered");

      // 1. SSRF cloud metadata block
      const ssrfProvider = new HttpModelProvider({
        name: "bad-ssrf",
        region: "eu-west-2",
        endpointUrl: "http://169.254.169.254/latest/meta-data/",
        apiKey: "test-key"
      });
      await assert.rejects(
        () =>
          ssrfProvider.generate({
            model: "test-model",
            system: "sys",
            messages: [{ role: "user", content: "hello" }],
            maxOutputTokens: 100,
            signal: new AbortController().signal
          }),
        /prohibited metadata|link-local/i
      );

      // 2. Region mismatch fails closed in callModel
      const usProvider = new HttpModelProvider({
        name: "eu-live-test",
        region: "us-east-1",
        endpointUrl: "https://api.example.com/v1/chat/completions",
        apiKey: "test-key"
      });
      await assert.rejects(
        () =>
          callModel(
            { ...DEFAULT_AI_USE_CASES.explain_release, providerName: "eu-live-test", providerRegion: "eu-west-2" },
            { system: "sys", messages: [{ role: "user", content: "hi" }] },
            { "eu-live-test": usProvider }
          ),
        /region eu-west-2 is not available/i
      );

      // 3. Valid region-pinned provider decodes OpenAI-compatible JSON payload via custom fetchImpl
      const goodProvider = new HttpModelProvider({
        name: "eu-live-test",
        region: "eu-west-2",
        endpointUrl: "https://api.example.com/v1/chat/completions",
        apiKey: "test-key",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ title: "OK", claims: [] }) } }],
              usage: { prompt_tokens: 42, completion_tokens: 18 }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )) as typeof fetch
      });
      const res = await callModel(
        { ...DEFAULT_AI_USE_CASES.explain_release, providerName: "eu-live-test", providerRegion: "eu-west-2" },
        { system: "sys", messages: [{ role: "user", content: "hi" }] },
        { "eu-live-test": goodProvider }
      );
      assert.strictEqual(JSON.parse(res.text).title, "OK");
      assert.strictEqual(res.usage.tokensIn, 42);
      assert.strictEqual(res.usage.tokensOut, 18);

      // 4. Env registration stays inactive unless AI_PROVIDER_MODE=live
      const tempReg: Record<string, any> = {};
      assert.strictEqual(registerConfiguredHttpProvider({ AI_PROVIDER_MODE: "mock" }, tempReg), null);
      const liveReg = registerConfiguredHttpProvider(
        {
          AI_PROVIDER_MODE: "live",
          AI_PROVIDER_NAME: "eu-gateway",
          AI_PROVIDER_REGION: "eu-west-2",
          AI_PROVIDER_ENDPOINT: "https://api.example.com/v1/chat/completions"
        },
        tempReg
      );
      assert.ok(liveReg && tempReg["eu-gateway"], "AI_PROVIDER_MODE=live must register HttpModelProvider");
    });
  console.log(`\n\x1b[32m✔ Additive Updates Verification Suite PASSED (${passed} checks).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[TEST-ADDITIVE ERROR]\x1b[0m", err);
  process.exit(1);
});
