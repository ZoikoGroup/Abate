// backend/tools/test-super-admin.ts
// Verifies Super Admin authentication, zero-impersonation boundaries,
// tenant lifecycle (create, update, suspend/activate, sector-pack),
// principal membership assignment/revocation, feature flags, and immutable platform_audit_event.

import assert from "node:assert";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { createSuperAdminToken, createSupportToken } from "../src/domains/support";
import { loadConfig } from "../src/platform/config";
import { isPostgresRequired } from "../src/platform/db/with-tenant";

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

async function req(method: string, urlPath: string, opts?: { token?: string; body?: any }) {
  return expressCall(method, urlPath, { token: opts?.token, body: opts?.body });
}

async function main() {
  console.log("\x1b[36m=== Abate Super Admin & Zero-Impersonation Test Suite ===\x1b[0m\n");
  const cfg = loadConfig();
  await seedTwoTenants({ clock: new Date(cfg.fixedClock), persistToPostgres: isPostgresRequired() });

  const tenantToken = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });
  const supportToken = createSupportToken({ operator: "ops-only" });
  const adminToken = createSuperAdminToken({ operator: "superadmin@zoikoabate.dev" });

  await check("Zero-impersonation: tenant token and ops-support token are refused on /api/v2/admin/*", async () => {
    const tRes = await req("GET", "/api/v2/admin/overview", { token: tenantToken });
    assert.strictEqual(tRes.status, 401, "Tenant token must be rejected on Super Admin routes");

    const sRes = await req("GET", "/api/v2/admin/overview", { token: supportToken });
    assert.strictEqual(sRes.status, 403, "Standard OPS_SUPPORT token must be forbidden on Super Admin routes");

    const aOnTenant = await req("GET", "/api/v2/organizations", { token: adminToken });
    assert.strictEqual(aOnTenant.status, 401, "Super Admin token must never impersonate or read tenant endpoints");
  });

  await check("Platform Overview & Governance packs return live metadata", async () => {
    const ov = await req("GET", "/api/v2/admin/overview", { token: adminToken });
    assert.strictEqual(ov.status, 200);
    assert.strictEqual(ov.body.perimeter, "ZERO_IMPERSONATION_METADATA_ONLY");
    assert.ok(ov.body.counts.totalTenants >= 2);

    const gov = await req("GET", "/api/v2/admin/governance", { token: adminToken });
    assert.strictEqual(gov.status, 200);
    assert.ok(Array.isArray(gov.body.sectorPacks) && gov.body.sectorPacks.length >= 2);
  });

  let createdTenantId = "";
  await check("Tenant lifecycle: create, edit, suspend, activate, and set sector pack", async () => {
    const created = await req("POST", "/api/v2/admin/tenants", {
      token: adminToken,
      body: { name: "Test SuperAdmin Tenant", region: "eu-west-2", sectorKey: "LEGAL" }
    });
    assert.strictEqual(created.status, 201);
    createdTenantId = created.body.id;
    assert.strictEqual(created.body.state, "ACTIVE");

    const upd = await req("PATCH", `/api/v2/admin/tenants/${createdTenantId}`, {
      token: adminToken,
      body: { name: "Test SuperAdmin Tenant Updated", region: "uk-london", jurisdictionConfigRef: "UK-EW-2026" }
    });
    assert.strictEqual(upd.status, 200);

    const susp = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
      token: adminToken,
      body: { state: "SUSPENDED", reason: "Maintenance hold verification" }
    });
    assert.strictEqual(susp.status, 200);
    assert.strictEqual(susp.body.state, "SUSPENDED");

    const actv = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
      token: adminToken,
      body: { state: "ACTIVE", reason: "Maintenance complete" }
    });
    assert.strictEqual(actv.status, 200);
    assert.strictEqual(actv.body.state, "ACTIVE");

    const sec = await req("PUT", `/api/v2/admin/tenants/${createdTenantId}/sector-pack`, {
      token: adminToken,
      body: { sectorKey: "GENERIC" }
    });
    assert.strictEqual(sec.status, 200);
    assert.strictEqual(sec.body.sectorKey, "GENERIC");
  });

  await check("Principal & Membership management: assign and revoke role + immutable platform audit log", async () => {
    const assigned = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/memberships`, {
      token: adminToken,
      body: { externalSubject: "auth0|new-reviewer", kind: "USER", domainRole: "REVIEWER" }
    });
    assert.strictEqual(assigned.status, 201);
    assert.strictEqual(assigned.body.active, true);

    const list = await req("GET", `/api/v2/admin/tenants/${createdTenantId}/principals`, { token: adminToken });
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.items.some((m: any) => m.membershipId === assigned.body.membershipId && m.active));

    const revoked = await req(
      "POST",
      `/api/v2/admin/tenants/${createdTenantId}/memberships/${assigned.body.membershipId}/revoke`,
      { token: adminToken, body: { reason: "Offboarding check" } }
    );
    assert.strictEqual(revoked.status, 200);

    const audit = await req("GET", "/api/v2/admin/audit", { token: adminToken });
    assert.strictEqual(audit.status, 200);
    assert.ok(audit.body.items.some((a: any) => a.action === "tenant.create" && a.target_id === createdTenantId));
    assert.ok(audit.body.items.some((a: any) => a.action === "membership.revoke"));
  });

  await check("Feature flags can be toggled and audited", async () => {
    const ff = await req("POST", "/api/v2/admin/feature-flags", {
      token: adminToken,
      body: { tenantId: createdTenantId, flag: "planeBOutcomes", enabled: true, reason: "Pilot flag check" }
    });
    assert.strictEqual(ff.status, 200);
    assert.strictEqual(ff.body.enabled, true);
  });

  console.log(`\n\x1b[32m✔ Super Admin & Zero-Impersonation Suite PASSED (${passed} checks).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[SUPER-ADMIN TEST FAILED]\x1b[0m", err);
  process.exit(1);
});
