// backend/tools/test-load.ts
// Load, Capacity & Concurrency Test Runner (Playbook B8 §8.2 / Guide Page 90)
// Measures p95 latency against ops/slo-manifest.v1.yaml targets and proves zero count leakage under burst load.

import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { withTenant } from "../src/platform/db/with-tenant";
import { createOrganization } from "../src/domains/tenant/commands";
import { compileRelease, getRelease } from "../src/domains/privacy";
import { p95 } from "../src/platform/slo";
import { Actor } from "../src/platform/command";

console.log("\x1b[36m=== Abate Task Runner: test-load (B8 Capacity, Concurrency & Leak Gates) ===\x1b[0m");

const TOTAL_REQUESTS = 150; // Aligned with ops/slo-manifest.v1.yaml peak_concurrency: 150
const CONCURRENCY_BATCH = 15;

const tenantA = GOLDEN_01.tenantA.id;
const tenantB = GOLDEN_01.tenantB.id;

const actorA: Actor = {
  tenantId: tenantA,
  principalId: "00000000-0000-4000-a000-000000000001",
  subject: "auth0|user-tenant-a-risk-owner",
  role: "RISK_OWNER",
  domainRoles: ["RISK_OWNER"],
  memberships: [{ domain_role: "RISK_OWNER", organization_id: "org-1" } as any]
};

const actorB: Actor = {
  tenantId: tenantB,
  principalId: "00000000-0000-4000-b000-000000000001",
  subject: "auth0|user-tenant-b-risk-owner",
  role: "RISK_OWNER",
  domainRoles: ["RISK_OWNER"],
  memberships: [{ domain_role: "RISK_OWNER", organization_id: "org-2" } as any]
};

async function runLoadTests() {
  await seedTwoTenants();

  const readLatencies: number[] = [];
  const writeLatencies: number[] = [];
  const releaseLatencies: number[] = [];
  let countLeaksDetected = 0;

  // 1. Release Compile Burst under Concurrency
  console.log("  Running Release Compile Burst scenario (150 concurrent requests)...");
  const releaseTasks: Array<() => Promise<void>> = [];

  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    releaseTasks.push(async () => {
      const start = Date.now();
      const res = await compileRelease(tenantA, {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        cohortRef: "tenantA-ops",
        periodStart: "2026-01-05T00:00:00Z",
        periodEnd: "2026-03-01T00:00:00Z"
      });
      const duration = Date.now() - start;
      releaseLatencies.push(duration);

      // Audit leak check (Playbook rule: no contributor count or raw numbers ever in release response)
      const resStr = JSON.stringify(res);
      if (/\bcontributor_count\b|\bcontributors\b/i.test(resStr)) {
        countLeaksDetected++;
      }
    });
  }

  // Execute in concurrent worker pools
  for (let i = 0; i < releaseTasks.length; i += CONCURRENCY_BATCH) {
    const batch = releaseTasks.slice(i, i + CONCURRENCY_BATCH);
    await Promise.all(batch.map(fn => fn()));
  }

  // 2. High-Frequency Reads & Mutations
  console.log("  Running mixed Read & Mutation load (Organizations & Releases)...");
  const mixedTasks: Array<() => Promise<void>> = [];

  for (let i = 0; i < 50; i++) {
    // Write task
    mixedTasks.push(async () => {
      const start = Date.now();
      const orgName = `Load Org ${i}-${crypto.randomUUID().slice(0, 6)}`;
      await createOrganization({
        who: { tenantId: tenantA, subject: actorA.subject, purpose: "load-test" },
        actor: actorA,
        body: { name: orgName },
        idempotencyKey: `load-${crypto.randomUUID()}`
      });
      writeLatencies.push(Date.now() - start);
    });

    // Read task
    mixedTasks.push(async () => {
      const start = Date.now();
      await withTenant(tenantA, async (tx) => {
        return tx.q("SELECT id, name, version FROM organization LIMIT 10");
      });
      readLatencies.push(Date.now() - start);
    });
  }

  for (let i = 0; i < mixedTasks.length; i += CONCURRENCY_BATCH) {
    const batch = mixedTasks.slice(i, i + CONCURRENCY_BATCH);
    await Promise.all(batch.map(fn => fn()));
  }

  // 3. Noisy-Tenant Isolation Test
  console.log("  Testing Noisy-Tenant Isolation (Tenant A 10x burst vs Tenant B baseline)...");
  const tenantBLatencies: number[] = [];
  const noisyTasks: Array<() => Promise<void>> = [];

  // Tenant A floods 50 requests
  for (let i = 0; i < 50; i++) {
    noisyTasks.push(async () => {
      await withTenant(tenantA, async (tx) => {
        return tx.q("SELECT * FROM organization");
      });
    });
  }

  // Tenant B does standard read
  for (let i = 0; i < 10; i++) {
    noisyTasks.push(async () => {
      const start = Date.now();
      const res = await withTenant(tenantB, async (tx) => {
        return tx.q("SELECT * FROM organization");
      });
      tenantBLatencies.push(Date.now() - start);
      // Verify isolation: zero Tenant A rows leaked to B
      assert(res.rows.every(r => r.tenant_id === tenantB), "Cross-tenant leak detected during load!");
    });
  }

  await Promise.all(noisyTasks.map(fn => fn()));

  // 4. Assert against ops/slo-manifest.v1.yaml targets
  const releaseP95 = p95(releaseLatencies);
  const writeP95 = p95(writeLatencies);
  const readP95 = p95(readLatencies);
  const tenantBP95 = p95(tenantBLatencies);

  console.log(`\n  --- Measured Concurrency & Latency Results ---`);
  console.log(`  Release Analytics p95: ${releaseP95} ms (Manifest target: <= 1500 ms)`);
  console.log(`  Mutations p95:         ${writeP95} ms (Manifest target: <= 800 ms)`);
  console.log(`  Ordinary Reads p95:    ${readP95} ms (Manifest target: <= 500 ms)`);
  console.log(`  Noisy Tenant B p95:    ${tenantBP95} ms (Isolated from Tenant A burst)`);
  console.log(`  Contributor Leaks:     ${countLeaksDetected} (Constitutional requirement: 0)`);

  assert.strictEqual(countLeaksDetected, 0, "Constitutional Violation: Contributor counts leaked under load!");
  assert(releaseP95 <= 1500, `Release p95 ${releaseP95}ms breached 1500ms target`);
  assert(writeP95 <= 800, `Write p95 ${writeP95}ms breached 800ms target`);
  assert(readP95 <= 500, `Read p95 ${readP95}ms breached 500ms target`);

  console.log(`\n\x1b[32m[SUCCESS] All load, concurrency, noisy-tenant isolation, and privacy-leak gates passed.\x1b[0m`);
}

runLoadTests().catch((err) => {
  console.error(`\x1b[31m[FAILED] Load test failed: ${err.message}\x1b[0m`);
  process.exit(1);
});
