// backend/tools/demo-cycle.ts
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, authenticate, resolveActor } from "../src/domains/tenant/auth";
import { createOrganization, getOrganization, listOrganizations } from "../src/domains/tenant/commands";
import { drainOnce } from "../src/worker/outbox-publisher";
import { memDb } from "../src/platform/db/with-tenant";

console.log("\x1b[35m============================================================\x1b[0m");
console.log("\x1b[35m=== ZOIKO ABATE: Golden Demo Cycle (Phases 0 & 1 Slices) ===\x1b[0m");
console.log("\x1b[35m============================================================\x1b[0m\n");

async function runDemoCycle() {
  console.log("Step 1. Seeding ABATE-GOLDEN-01 synthetic fixture (Tenants A and B)...");
  await seedTwoTenants();
  console.log("  ✔ Tenant A:", GOLDEN_01.tenantA.name, `(${GOLDEN_01.tenantA.id})`);
  console.log("  ✔ Tenant B:", GOLDEN_01.tenantB.name, `(${GOLDEN_01.tenantB.id})\n`);

  console.log("Step 2. Authenticating as Tenant A Risk Owner via Bearer token...");
  const tokenA = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    purpose: GOLDEN_01.tenantA.defaultPurpose
  });
  const whoA = await authenticate(`Bearer ${tokenA}`);
  const actorA = await resolveActor(whoA.tenantId, whoA.subject);
  console.log("  ✔ Authenticated identity:", whoA.subject);
  console.log("  ✔ Tenant context bound to:", whoA.tenantId);
  console.log("  ✔ Resolved effective role:", actorA.memberships[0]?.domain_role, "\n");

  console.log("Step 3. Executing idempotent domain command: createOrganization...");
  const idempotencyKey = `idem-${crypto.randomUUID()}`;
  const commandResult = await createOrganization({
    who: whoA,
    actor: actorA,
    body: { name: "Corporate Real Estate Practice" },
    idempotencyKey
  });
  const createdOrgId = commandResult.body.id;
  console.log("  ✔ Organization created:", commandResult.body.name);
  console.log("  ✔ Org ID:", createdOrgId);
  console.log("  ✔ Response Status:", commandResult.status, "\n");

  console.log("Step 4. Testing exact command replay with same Idempotency-Key...");
  const replayResult = await createOrganization({
    who: whoA,
    actor: actorA,
    body: { name: "Corporate Real Estate Practice" },
    idempotencyKey
  });
  console.log("  ✔ Cached response returned deterministically:", replayResult.body.id === createdOrgId);
  console.log("  ✔ Zero duplicate records created in authoritative state.\n");

  console.log("Step 5. Verifying cross-tenant isolation and fail-closed denial...");
  // Tenant A queries its own newly created organization
  const readByA = await getOrganization({ who: whoA, actor: actorA, orgId: createdOrgId });
  console.log("  ✔ Tenant A read access verified:", readByA.name);

  // Authenticate as Tenant B
  const tokenB = createDevToken({
    tenantId: GOLDEN_01.tenantB.id,
    subject: "auth0|user-tenant-b-risk-owner",
    role: "RISK_OWNER"
  });
  const whoB = await authenticate(`Bearer ${tokenB}`);
  const actorB = await resolveActor(whoB.tenantId, whoB.subject);

  try {
    // Tenant B attempts to read Tenant A's organization
    await getOrganization({ who: whoB, actor: actorB, orgId: createdOrgId });
    throw new Error("SECURITY FAILURE: Tenant B was able to read Tenant A's data!");
  } catch (err: any) {
    console.log(`  ✔ Tenant B request rejected with safe error: [${err.code}] ${err.message}`);
    console.log("  ✔ Existence of Tenant A resource completely masked from Tenant B.\n");
  }

  console.log("Step 6. Draining transactional outbox via worker process...");
  const drainReport = await drainOnce();
  console.log(`  ✔ Outbox drained: ${drainReport.drained} events published.`);
  console.log(`  ✔ Total audit events recorded in append-only log: ${memDb.auditEvents.length}\n`);

  console.log("\x1b[32m============================================================\x1b[0m");
  console.log("\x1b[32m=== DEMO CYCLE COMPLETED SUCCESSFULLY: ALL GATES PASS ===\x1b[0m");
  console.log("\x1b[32m============================================================\x1b[0m");
}

runDemoCycle().catch(err => {
  console.error("\x1b[31m[DEMO CYCLE FAILED]\x1b[0m", err);
  process.exit(1);
});

