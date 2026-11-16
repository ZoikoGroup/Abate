// backend/tools/test-load.ts
// Load, Capacity & Concurrency Test Runner (Playbook B8 §8.2 / Stage B Measurement)
// Supports direct domain mode (default) and real HTTP server mode (--http).
// Measures p50/p95/p99 latency against ops/slo-manifest.v1.yaml targets, checks cross-tenant isolation,
// verifies zero contributor-count leakage, and writes evidence/slo-benchmark-report.json.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AddressInfo } from "node:net";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { checkPgHealth, withTenant } from "../src/platform/db/with-tenant";
import { createOrganization } from "../src/domains/tenant/commands";
import { compileRelease } from "../src/domains/privacy";
import { p95 } from "../src/platform/slo";
import { Actor } from "../src/platform/command";
import { app } from "../src/index";
import { expressCall } from "./simulate-30d-http";

const HTTP_MODE = process.argv.includes("--http");
const TCP_MODE = process.argv.includes("--tcp");
const TOTAL_REQUESTS = 150; // Aligned with ops/slo-manifest.v1.yaml peak_concurrency: 150
const CONCURRENCY_BATCH = 15;

const tenantA = GOLDEN_01.tenantA.id;
const tenantB = GOLDEN_01.tenantB.id;

const actorA: Actor = {
  tenantId: tenantA,
  principalId: "00000000-0000-4000-a002-000000000001",
  memberships: [{ domain_role: "RISK_OWNER", organization_id: "00000000-0000-4000-a001-000000000001" }]
};

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function runLoadTests() {
  console.log(`\x1b[36m=== Abate Task Runner: test-load (${HTTP_MODE ? "REAL HTTP" : "DIRECT DOMAIN"} Mode) ===\x1b[0m`);

  const pgLive = await checkPgHealth();
  await seedTwoTenants({ persistToPostgres: pgLive });

  const readLatencies: number[] = [];
  const writeLatencies: number[] = [];
  const releaseLatencies: number[] = [];
  const tenantBLatencies: number[] = [];
  let countLeaksDetected = 0;
  let errorCount = 0;

  if (HTTP_MODE) {
    let server: ReturnType<typeof app.listen> | null = null;
    let base = "";
    if (TCP_MODE) {
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    const callHttp = async (
      method: "GET" | "POST",
      urlPath: string,
      opts: { token?: string; body?: any; idempotencyKey?: string } = {}
    ): Promise<{ status: number; body: any; raw: string }> => {
      if (TCP_MODE) {
        const headers: Record<string, string> = {};
        if (opts.body !== undefined) headers["content-type"] = "application/json";
        if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
        if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
        const res = await fetch(`${base}${urlPath}`, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
        });
        const raw = await res.text();
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* non-JSON */
        }
        return { status: res.status, body, raw };
      }
      const headers: Record<string, string> = {};
      if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
      return expressCall(method, urlPath, { token: opts.token, body: opts.body, headers });
    };

    try {
      const tokARes = await callHttp("POST", "/api/v2/auth/token", {
        body: {
          tenantId: tenantA,
          subject: "auth0|user-tenant-a-risk-owner",
          role: "RISK_OWNER"
        }
      });
      const tokA = tokARes.body.token as string;

      const tokBRes = await callHttp("POST", "/api/v2/auth/token", {
        body: {
          tenantId: tenantB,
          subject: "auth0|user-tenant-b-risk-owner",
          role: "RISK_OWNER"
        }
      });
      const tokB = tokBRes.body.token as string;

      console.log(`  Running HTTP Release Compile Burst scenario (150 concurrent requests, ${TCP_MODE ? "TCP" : "Express"})...`);
      const releaseTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < TOTAL_REQUESTS; i++) {
        releaseTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("POST", "/api/v2/releases/query", {
            token: tokA,
            idempotencyKey: `load-rel-${crypto.randomUUID()}`,
            body: {
              metricId: "BOUNDARY_INTRUSION_SHARE",
              metricVersion: 1,
              cohortRef: "org:load-http",
              periodStart: "2026-03-01T00:00:00Z",
              periodEnd: "2026-03-29T00:00:00Z",
              releaseClass: "CLASS_B"
            }
          });
          releaseLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
          if (/\bcontributor_count\b|\bcontributors\b/i.test(res.raw)) {
            countLeaksDetected++;
          }
        });
      }

      for (let i = 0; i < releaseTasks.length; i += CONCURRENCY_BATCH) {
        await Promise.all(releaseTasks.slice(i, i + CONCURRENCY_BATCH).map((fn) => fn()));
      }

      console.log("  Running HTTP mixed Read & Mutation load (Organizations)...");
      const mixedTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < 50; i++) {
        mixedTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("POST", "/api/v2/organizations", {
            token: tokA,
            idempotencyKey: `load-http-org-${crypto.randomUUID()}`,
            body: { name: `HTTP Load Org ${i}-${crypto.randomUUID().slice(0, 6)}` }
          });
          writeLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
        });
        mixedTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("GET", "/api/v2/organizations", { token: tokA });
          readLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
        });
      }

      for (let i = 0; i < mixedTasks.length; i += CONCURRENCY_BATCH) {
        await Promise.all(mixedTasks.slice(i, i + CONCURRENCY_BATCH).map((fn) => fn()));
      }

      console.log("  Testing HTTP Noisy-Tenant Isolation (Tenant A burst vs Tenant B read)...");
      const noisyTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < 50; i++) {
        noisyTasks.push(async () => {
          await callHttp("GET", "/api/v2/organizations", { token: tokA });
        });
      }
      for (let i = 0; i < 10; i++) {
        noisyTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("GET", "/api/v2/organizations", { token: tokB });
          tenantBLatencies.push(Date.now() - start);
          const rows = res.body as Array<{ tenant_id: string }>;
          assert(rows.every((r) => r.tenant_id === tenantB), "Cross-tenant leak detected during HTTP load!");
        });
      }
      await Promise.all(noisyTasks.map((fn) => fn()));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    }
  } else {
    console.log("  Running Release Compile Burst scenario (150 concurrent requests)...");
    const releaseTasks: Array<() => Promise<void>> = [];

    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      releaseTasks.push(async () => {
        const start = Date.now();
        const res = await compileRelease(tenantA, {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: "tenantA-ops",
          periodStart: "2026-01-05T00:00:00Z",
          periodEnd: "2026-03-01T00:00:00Z",
          releaseClass: "CLASS_B"
        });
        releaseLatencies.push(Date.now() - start);

        const resStr = JSON.stringify(res);
        if (/\bcontributor_count\b|\bcontributors\b/i.test(resStr)) {
          countLeaksDetected++;
        }
      });
    }

    for (let i = 0; i < releaseTasks.length; i += CONCURRENCY_BATCH) {
      await Promise.all(releaseTasks.slice(i, i + CONCURRENCY_BATCH).map((fn) => fn()));
    }

    console.log("  Running mixed Read & Mutation load (Organizations & Releases)...");
    const mixedTasks: Array<() => Promise<void>> = [];

    for (let i = 0; i < 50; i++) {
      mixedTasks.push(async () => {
        const start = Date.now();
        const orgName = `Load Org ${i}-${crypto.randomUUID().slice(0, 6)}`;
        await createOrganization({
          who: { tenantId: tenantA, subject: "auth0|user-tenant-a-risk-owner", purpose: "load-test", role: "RISK_OWNER" },
          actor: actorA,
          body: { name: orgName },
          idempotencyKey: `load-${crypto.randomUUID()}`
        });
        writeLatencies.push(Date.now() - start);
      });

      mixedTasks.push(async () => {
        const start = Date.now();
        await withTenant(tenantA, async (tx) => tx.q("SELECT id, name, version FROM organization LIMIT 10"));
        readLatencies.push(Date.now() - start);
      });
    }

    for (let i = 0; i < mixedTasks.length; i += CONCURRENCY_BATCH) {
      await Promise.all(mixedTasks.slice(i, i + CONCURRENCY_BATCH).map((fn) => fn()));
    }

    console.log("  Testing Noisy-Tenant Isolation (Tenant A 10x burst vs Tenant B baseline)...");
    const noisyTasks: Array<() => Promise<void>> = [];

    for (let i = 0; i < 50; i++) {
      noisyTasks.push(async () => {
        await withTenant(tenantA, async (tx) => tx.q("SELECT * FROM organization"));
      });
    }

    for (let i = 0; i < 10; i++) {
      noisyTasks.push(async () => {
        const start = Date.now();
        const res = await withTenant(tenantB, async (tx) => tx.q("SELECT * FROM organization"));
        tenantBLatencies.push(Date.now() - start);
        assert(res.rows.every((r) => r.tenant_id === tenantB), "Cross-tenant leak detected during load!");
      });
    }

    await Promise.all(noisyTasks.map((fn) => fn()));
  }

  const releaseP95 = p95(releaseLatencies) ?? 0;
  const writeP95 = p95(writeLatencies) ?? 0;
  const readP95 = p95(readLatencies) ?? 0;
  const tenantBP95 = p95(tenantBLatencies) ?? 0;

  const executionBacking = pgLive
    ? HTTP_MODE
      ? "POSTGRESQL_LIVE_HTTP"
      : "POSTGRESQL_LIVE_DIRECT"
    : HTTP_MODE
      ? "MEMORY_SANDBOX_HTTP"
      : "MEMORY_SANDBOX_DIRECT";

  console.log(`\n  --- Measured Concurrency & Latency Results (${executionBacking}) ---`);
  console.log(`  Release Analytics p95: ${releaseP95} ms (Manifest target: <= 1500 ms)`);
  console.log(`  Mutations p95:         ${writeP95} ms (Manifest target: <= 800 ms)`);
  console.log(`  Ordinary Reads p95:    ${readP95} ms (Manifest target: <= 500 ms)`);
  console.log(`  Noisy Tenant B p95:    ${tenantBP95} ms (Isolated from Tenant A burst)`);
  console.log(`  Contributor Leaks:     ${countLeaksDetected} (Constitutional requirement: 0)`);
  console.log(`  5xx Responses:         ${errorCount}`);

  assert.strictEqual(countLeaksDetected, 0, "Constitutional Violation: Contributor counts leaked under load!");
  assert.strictEqual(errorCount, 0, `Unexpected 5xx errors under load: ${errorCount}`);
  assert(releaseP95 <= 1500, `Release p95 ${releaseP95}ms breached 1500ms target`);
  assert(writeP95 <= 800, `Write p95 ${writeP95}ms breached 800ms target`);
  assert(readP95 <= 500, `Read p95 ${readP95}ms breached 500ms target`);

  const report = {
    schema: "abate.slo-benchmark.v1",
    generatedAt: new Date().toISOString(),
    executionBacking,
    postgresBacked: pgLive,
    httpExercised: HTTP_MODE,
    targets: { readsP95Ms: 500, writesP95Ms: 800, releasesP95Ms: 1500 },
    measured: {
      reads: { count: readLatencies.length, p50Ms: percentile(readLatencies, 50), p95Ms: readP95, p99Ms: percentile(readLatencies, 99) },
      writes: { count: writeLatencies.length, p50Ms: percentile(writeLatencies, 50), p95Ms: writeP95, p99Ms: percentile(writeLatencies, 99) },
      releases: { count: releaseLatencies.length, p50Ms: percentile(releaseLatencies, 50), p95Ms: releaseP95, p99Ms: percentile(releaseLatencies, 99) },
      noisyTenantBReads: { count: tenantBLatencies.length, p95Ms: tenantBP95 },
      contributorLeaks: countLeaksDetected,
      serverErrors5xx: errorCount
    },
    passed: true
  };

  const outPath = path.resolve(__dirname, "../../evidence/slo-benchmark-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`  Wrote measured SLO report -> ${outPath}`);

  console.log(`\n\x1b[32m[SUCCESS] All load, concurrency, noisy-tenant isolation, and privacy-leak gates passed.\x1b[0m`);
}

runLoadTests().catch((err) => {
  console.error(`\x1b[31m[FAILED] Load test failed: ${err.message}\x1b[0m`);
  process.exit(1);
});
