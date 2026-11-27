// backend/tools/test-super-admin.ts
// Verifies hardened Super Admin platform controls:
// - Dedicated zero-impersonation boundary & role separation (401/403)
// - Admin HttpOnly SameSite=Strict session cookie + X-Admin-Csrf protection
// - Step-up re-authentication (401 missing/expired -> 200 after step-up)
// - Four-eyes approval (202 PENDING_APPROVAL, 403 self-approval, 200 second admin, 409 replay)
// - Optimistic concurrency (ETag / If-Match 409) & strict Zod rejection (400 unknown fields)
// - Preview sector-pack lockdown (403 on admin & tenant routes)
// - DPO-safe pseudonymous/masked principals + audited view + EMPLOYER_ADMIN-only bootstrap
// - Commercial entitlements (privacy-floor keys refused 403), AI quota, kill switches, operations
// - Immutable platform_audit_event (operator, approver, reason, request_id, audited export)

import assert from "node:assert";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { createSuperAdminToken, createSupportToken, SUPER_ADMIN_SCOPE } from "../src/domains/support";
import { loadConfig, resetConfigCache } from "../src/platform/config";
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

async function req(
  method: string,
  urlPath: string,
  opts?: { token?: string; body?: any; headers?: Record<string, string> }
) {
  return expressCall(method, urlPath, {
    token: opts?.token,
    body: opts?.body,
    headers: opts?.headers
  });
}

async function main() {
  console.log("\x1b[36m=== Abate Hardened Super Admin & Governance Test Suite ===\x1b[0m\n");
  const cfg = loadConfig();
  const suffix = crypto.randomUUID().slice(0, 8);
  await seedTwoTenants({ clock: new Date(cfg.fixedClock), persistToPostgres: isPostgresRequired() });

  const tenantToken = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });
  const supportToken = createSupportToken({ operator: "ops.support@zoikoabate.dev" });
  const admin1NoStepUp = createSuperAdminToken({ operator: "alice.admin@zoikoabate.dev", stepUpAt: null });
  const admin1ExpiredStepUp = createSuperAdminToken({
    operator: "alice.admin@zoikoabate.dev",
    stepUpAt: Math.floor(Date.now() / 1000) - (cfg.adminStepUpWindowSeconds + 120)
  });
  let admin1Token = admin1NoStepUp;
  const admin2Token = createSuperAdminToken({
    operator: "bob.admin@zoikoabate.dev",
    stepUpAt: Math.floor(Date.now() / 1000)
  });

  await check("Zero-impersonation: anon, tenant token, and OPS_SUPPORT are refused on /api/v2/admin/*; SUPER_ADMIN refused on tenant routes", async () => {
    const anonRes = await req("GET", "/api/v2/admin/overview");
    assert.strictEqual(anonRes.status, 401, "Unauthenticated request must be 401");

    const tRes = await req("GET", "/api/v2/admin/overview", { token: tenantToken });
    assert.strictEqual(tRes.status, 401, "Tenant token must be rejected on Super Admin routes");

    const sRes = await req("GET", "/api/v2/admin/overview", { token: supportToken });
    assert.strictEqual(sRes.status, 403, "OPS_SUPPORT token must be forbidden on Super Admin routes");

    for (const tenantRoute of ["/api/v2/organizations", "/api/v2/hazards", "/api/v2/work-facts", "/api/v2/tenant-admin/users"]) {
      const aOnTenant = await req("GET", tenantRoute, { token: admin2Token });
      assert.strictEqual(aOnTenant.status, 401, `Super Admin token must never access ${tenantRoute}`);
    }
  });

  await check("Admin session cookie (HttpOnly SameSite=Strict) + CSRF check + /api/v2/admin/me banner", async () => {
    const issued = await req("POST", "/api/v2/auth/super-admin-token", {
      body: { operator: "alice.admin@zoikoabate.dev", stepUp: false }
    });
    assert.strictEqual(issued.status, 200);
    assert.ok(issued.body.token && issued.body.csrfToken);
    const cookieHeader = `abate_admin_session=${encodeURIComponent(issued.body.token)}; abate_admin_csrf=${encodeURIComponent(issued.body.csrfToken)}`;

    // Cookie read succeeds
    const me = await req("GET", "/api/v2/admin/me", { headers: { cookie: cookieHeader } });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.banner, "Platform admin: no tenant business data is shown here.");
    assert.ok(Array.isArray(me.body.allowedNav) && me.body.allowedNav.includes("approvals"));
    assert.strictEqual(me.body.stepUpVerified, false);

    // Cookie mutation without X-Admin-Csrf refused 403
    const noCsrf = await req("POST", "/api/v2/admin/session/step-up", {
      headers: { cookie: cookieHeader },
      body: { confirmation: "CONFIRM" }
    });
    assert.strictEqual(noCsrf.status, 403, "Cookie-backed admin mutation without X-Admin-Csrf must return 403");

    // Cookie mutation with wrong X-Admin-Csrf refused 403
    const badCsrf = await req("POST", "/api/v2/admin/session/step-up", {
      headers: { cookie: cookieHeader, "x-admin-csrf": "wrong-csrf-value" },
      body: { confirmation: "CONFIRM" }
    });
    assert.strictEqual(badCsrf.status, 403, "Cookie-backed admin mutation with mismatched CSRF token must return 403");

    // Cookie mutation with valid X-Admin-Csrf succeeds 200
    const goodCsrf = await req("POST", "/api/v2/admin/session/step-up", {
      headers: { cookie: cookieHeader, "x-admin-csrf": issued.body.csrfToken },
      body: { confirmation: "CONFIRM" }
    });
    assert.strictEqual(goodCsrf.status, 200);
    assert.ok(goodCsrf.body.token);
  });

  await check("Step-up re-authentication: missing or expired step-up returns 401; POST /admin/session/step-up upgrades session", async () => {
    const noStep = await req("POST", `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}/state`, {
      token: admin1NoStepUp,
      body: { state: "SUSPENDED", reason: "Testing missing step-up enforcement" }
    });
    assert.strictEqual(noStep.status, 401, "Missing step-up must fail with 401");

    const expStep = await req("POST", `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}/state`, {
      token: admin1ExpiredStepUp,
      body: { state: "SUSPENDED", reason: "Testing expired step-up enforcement" }
    });
    assert.strictEqual(expStep.status, 401, "Expired step-up must fail with 401");

    const upgraded = await req("POST", "/api/v2/admin/session/step-up", {
      token: admin1NoStepUp,
      body: { confirmation: "REAUTH-ALICE", mfaCode: "654321" }
    });
    assert.strictEqual(upgraded.status, 200);
    assert.ok(upgraded.body.token && upgraded.body.stepUpExpiresAt);
    admin1Token = upgraded.body.token;

    const meAfter = await req("GET", "/api/v2/admin/me", { token: admin1Token });
    assert.strictEqual(meAfter.status, 200);
    assert.strictEqual(meAfter.body.stepUpVerified, true);
  });

  await check("Platform Overview & Governance packs flag preview packs as not enabled", async () => {
    const ov = await req("GET", "/api/v2/admin/overview", { token: admin1Token });
    assert.strictEqual(ov.status, 200);
    assert.strictEqual(ov.body.perimeter, "ZERO_IMPERSONATION_METADATA_ONLY");
    assert.ok(ov.body.counts.totalTenants >= 2);

    const gov = await req("GET", "/api/v2/admin/governance", { token: admin1Token });
    assert.strictEqual(gov.status, 200);
    assert.ok(Array.isArray(gov.body.sectorPacks) && gov.body.sectorPacks.length >= 2);
    const hc = gov.body.sectorPacks.find((p: any) => p.sectorKey === "HEALTHCARE");
    assert.ok(hc && hc.enableable === false && hc.statusLabel === "preview, not enabled");
  });

  let createdTenantId = "";
  let createdTenantVersion = 1;
  await check("Tenant create/edit: strict validation (400 unknown field), preview packs refused (403), ETag/If-Match (409)", async () => {
    const unknownField = await req("POST", "/api/v2/admin/tenants", {
      token: admin1Token,
      body: { name: "Bad Field Corp", region: "eu-west-2", sectorKey: "GENERIC", reason: "Valid reason", unexpected: true }
    });
    assert.strictEqual(unknownField.status, 400, "Unknown fields must be rejected with 400");

    const missingReason = await req("POST", "/api/v2/admin/tenants", {
      token: admin1Token,
      body: { name: "No Reason Corp", region: "eu-west-2", sectorKey: "GENERIC" }
    });
    assert.strictEqual(missingReason.status, 400, "Missing reason must be rejected with 400");

    for (const previewPack of ["HEALTHCARE", "ACCOUNTING", "SOFTWARE_IT", "FINANCE"]) {
      const blocked = await req("POST", "/api/v2/admin/tenants", {
        token: admin1Token,
        body: { name: `Preview ${previewPack}`, region: "eu-west-2", sectorKey: previewPack, reason: "Testing preview block" }
      });
      assert.strictEqual(blocked.status, 403, `Preview pack ${previewPack} must be blocked with 403 on tenant creation`);
    }

    const created = await req("POST", "/api/v2/admin/tenants", {
      token: admin1Token,
      body: { name: `SuperAdmin Tenant ${suffix}`, region: "eu-west-2", sectorKey: "GENERIC", reason: "Onboarding approved customer tenant" }
    });
    assert.strictEqual(created.status, 201);
    createdTenantId = created.body.id;
    createdTenantVersion = created.body.version;
    assert.strictEqual(created.body.state, "ACTIVE");
    assert.strictEqual(createdTenantVersion, 1);

    const detail = await req("GET", `/api/v2/admin/tenants/${createdTenantId}`, { token: admin1Token });
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.version, 1);

    const stalePatch = await req("PATCH", `/api/v2/admin/tenants/${createdTenantId}`, {
      token: admin1Token,
      headers: { "if-match": '"999"' },
      body: { name: "Stale Update", region: "uk-london", reason: "Testing stale ETag rejection" }
    });
    assert.strictEqual(stalePatch.status, 409, "Stale If-Match must return 409");

    const upd = await req("PATCH", `/api/v2/admin/tenants/${createdTenantId}`, {
      token: admin1Token,
      headers: { "if-match": `"${createdTenantVersion}"` },
      body: {
        name: `SuperAdmin Tenant Updated ${suffix}`,
        region: "uk-london",
        jurisdictionConfigRef: "UK-EW-2026",
        reason: "Updated jurisdiction binding"
      }
    });
    assert.strictEqual(upd.status, 200);
    createdTenantVersion = upd.body.version;
    assert.strictEqual(createdTenantVersion, 2);
  });

  await check("Four-eyes tenant suspension: 202 pending -> 403 self-approve -> 200 second admin -> 409 replay -> suspended tenant blocked (403) -> reactivate", async () => {
    const bootstrapRes = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/memberships`, {
      token: admin1Token,
      body: {
        externalSubject: `auth0|admin-${suffix}@customer.example`,
        kind: "USER",
        domainRole: "EMPLOYER_ADMIN",
        reason: "Initial tenant admin bootstrap"
      }
    });
    assert.strictEqual(bootstrapRes.status, 201);

    const customerToken = createDevToken({
      tenantId: createdTenantId,
      subject: `auth0|admin-${suffix}@customer.example`,
      role: "EMPLOYER_ADMIN"
    });
    const activeCheck = await req("GET", "/api/v2/organizations", { token: customerToken });
    assert.strictEqual(activeCheck.status, 200, "Active tenant user should succeed before suspension");

    // Stale If-Match rejected on state change
    const staleSuspend = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
      token: admin1Token,
      headers: { "if-match": '"999"' },
      body: { state: "SUSPENDED", reason: "Testing stale If-Match on suspend" }
    });
    assert.strictEqual(staleSuspend.status, 409);

    // Initiate suspend -> 202 PENDING_APPROVAL
    const suspReq = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
      token: admin1Token,
      headers: { "if-match": `"${createdTenantVersion}"` },
      body: { state: "SUSPENDED", reason: "Maintenance hold verification" }
    });
    assert.strictEqual(suspReq.status, 202);
    assert.strictEqual(suspReq.body.status, "PENDING_APPROVAL");
    const approvalId = suspReq.body.approvalRequest.id;
    assert.ok(approvalId);

    // Self-approval MUST fail 403
    const selfApprove = await req("POST", `/api/v2/admin/approvals/${approvalId}/approve`, {
      token: admin1Token,
      body: { reason: "Trying to self-approve" }
    });
    assert.strictEqual(selfApprove.status, 403, "Self-approval must be refused with 403");

    // Second distinct Super Admin approves -> 200 EXECUTED
    const secondApprove = await req("POST", `/api/v2/admin/approvals/${approvalId}/approve`, {
      token: admin2Token,
      body: { reason: "Verified ticket #4410 maintenance hold" }
    });
    assert.strictEqual(secondApprove.status, 200);
    assert.strictEqual(secondApprove.body.status, "EXECUTED");
    assert.strictEqual(secondApprove.body.result.state, "SUSPENDED");

    // Replaying same approval MUST fail 409
    const replayApprove = await req("POST", `/api/v2/admin/approvals/${approvalId}/approve`, {
      token: admin2Token,
      body: { reason: "Replay attempt" }
    });
    assert.strictEqual(replayApprove.status, 409, "Replayed approval must be refused with 409");

    // Suspended tenant blocks customer calls (403)
    const blockedCustomer = await req("GET", "/api/v2/organizations", { token: customerToken });
    assert.strictEqual(blockedCustomer.status, 403, "Suspended tenant must refuse tenant API calls");

    // Reactivate tenant
    const actv = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
      token: admin1Token,
      body: { state: "ACTIVE", reason: "Maintenance complete and verified" }
    });
    assert.strictEqual(actv.status, 200);
    assert.strictEqual(actv.body.state, "ACTIVE");
    createdTenantVersion = actv.body.version;

    // Customer resumes cleanly after reactivation
    const resumedCustomer = await req("GET", "/api/v2/organizations", { token: customerToken });
    assert.strictEqual(resumedCustomer.status, 200, "Reactivated tenant should resume cleanly");
  });

  await check("Offboard request routes through four-eyes retention/legal-hold/tombstone (never hard deletes)", async () => {
    const offReq = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/offboard-request`, {
      token: admin1Token,
      body: { reason: "Customer contract termination notice received" }
    });
    assert.strictEqual(offReq.status, 202);
    const offApproval = await req("POST", `/api/v2/admin/approvals/${offReq.body.approvalRequest.id}/approve`, {
      token: admin2Token,
      body: { reason: "Approved retention/legal-hold/tombstone offboarding" }
    });
    assert.strictEqual(offApproval.status, 200);
    assert.strictEqual(offApproval.body.result.offboardRequested, true);

    const stillExists = await req("GET", `/api/v2/admin/tenants/${createdTenantId}`, { token: admin1Token });
    assert.strictEqual(stillExists.status, 200, "Tenant must never be instantly hard-deleted");
    assert.ok(stillExists.body.offboardRequestedAt, "offboardRequestedAt must be populated");
  });

  await check("Sector pack governance: preview blocked (403) on admin & tenant routes; launched pack requires four-eyes (202 -> 200)", async () => {
    const badField = await req("PUT", `/api/v2/admin/tenants/${createdTenantId}/sector-pack`, {
      token: admin1Token,
      body: { sectorKey: "GENERIC", reason: "Test strict", extra: 1 }
    });
    assert.strictEqual(badField.status, 400);

    const previewAdmin = await req("PUT", `/api/v2/admin/tenants/${createdTenantId}/sector-pack`, {
      token: admin1Token,
      body: { sectorKey: "HEALTHCARE", reason: "Testing preview block on admin route" }
    });
    assert.strictEqual(previewAdmin.status, 403);

    const previewTenant = await req("PUT", "/api/v2/tenant/sector-profile", {
      token: tenantToken,
      headers: { "idempotency-key": `idem-prev-${suffix}` },
      body: { sectorKey: "HEALTHCARE", packKey: "healthcare-preview" }
    });
    assert.strictEqual(previewTenant.status, 403, "Tenant route must also block preview packs");

    // Launched pack LEGAL -> 202 four-eyes -> Admin #2 approves -> 200
    const legalReq = await req("PUT", `/api/v2/admin/tenants/${createdTenantId}/sector-pack`, {
      token: admin1Token,
      body: { sectorKey: "LEGAL", reason: "Enabling launched legal pack for pilot" }
    });
    assert.strictEqual(legalReq.status, 202);
    const legalApproved = await req("POST", `/api/v2/admin/approvals/${legalReq.body.approvalRequest.id}/approve`, {
      token: admin2Token,
      body: { reason: "Verified customer is in legal pilot scope" }
    });
    assert.strictEqual(legalApproved.status, 200);
    assert.strictEqual(legalApproved.body.result.sectorKey, "LEGAL");
  });

  await check("Tenant Users & Access: DPO-safe pseudonymous/masked principals + audited view + separation rules", async () => {
    // Refuse approval & workflow roles
    for (const forbiddenRole of ["APPROVER", "RISK_OWNER", "CONTROL_OWNER", "REVIEWER"]) {
      const refused = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/memberships`, {
        token: admin1Token,
        body: { externalSubject: `auth0|blocked-${forbiddenRole}`, kind: "USER", domainRole: forbiddenRole, reason: "Testing role separation" }
      });
      assert.strictEqual(refused.status, 403, `Super Admin must be refused granting ${forbiddenRole}`);
    }

    // Refuse self-assignment & platform staff assignment
    const selfAssign = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/memberships`, {
      token: admin1Token,
      body: { externalSubject: "alice.admin@zoikoabate.dev", kind: "USER", domainRole: "EMPLOYER_ADMIN", reason: "Self assign test" }
    });
    assert.strictEqual(selfAssign.status, 403, "Super Admin must not grant themselves a tenant membership");

    const staffAssign = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/memberships`, {
      token: admin1Token,
      body: { externalSubject: "superadmin-2@zoikoabate.dev", kind: "USER", domainRole: "EMPLOYER_ADMIN", reason: "Staff assign test" }
    });
    assert.strictEqual(staffAssign.status, 403, "Platform staff cannot hold tenant memberships");

    // Bootstrap second EMPLOYER_ADMIN, inspect pseudonymous/masked list, then revoke
    const boot = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/memberships`, {
      token: admin1Token,
      body: { externalSubject: `jane.doe.${suffix}@customer.example`, kind: "USER", domainRole: "EMPLOYER_ADMIN", reason: "Secondary admin bootstrap" }
    });
    assert.strictEqual(boot.status, 201);
    assert.ok(boot.body.pseudonymousId && boot.body.maskedSubject);
    assert.ok(!("externalSubject" in boot.body), "Raw externalSubject must not be returned by Super Admin route");

    const list = await req("GET", `/api/v2/admin/tenants/${createdTenantId}/principals`, { token: admin1Token });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.privacyMode, "PSEUDONYMOUS_MASKED_AUDITED");
    assert.ok(list.body.items.some((m: any) => m.membershipId === boot.body.membershipId && m.active));
    for (const item of list.body.items) {
      assert.ok(item.pseudonymousId && item.maskedSubject);
      assert.strictEqual("externalSubject" in item, false, "Super Admin principals list must never expose raw externalSubject");
    }

    const badRevoke = await req(
      "POST",
      `/api/v2/admin/tenants/${createdTenantId}/memberships/${boot.body.membershipId}/revoke`,
      { token: admin1Token, body: { reason: "Testing unknown field", bogus: 123 } }
    );
    assert.strictEqual(badRevoke.status, 400);

    const revoked = await req(
      "POST",
      `/api/v2/admin/tenants/${createdTenantId}/memberships/${boot.body.membershipId}/revoke`,
      { token: admin1Token, body: { reason: "Revoking temporary bootstrap membership" } }
    );
    assert.strictEqual(revoked.status, 200);

    // Cross-tenant revoke guard: supplying Tenant B's real membershipId under createdTenantId MUST return 404 and leave Tenant B untouched
    const tenantBMembershipId = "00000000-0000-4000-b003-000000000001";
    const crossTenantRevoke = await req(
      "POST",
      `/api/v2/admin/tenants/${createdTenantId}/memberships/${tenantBMembershipId}/revoke`,
      { token: admin1Token, body: { reason: "Cross-tenant revoke isolation check" } }
    );
    assert.strictEqual(crossTenantRevoke.status, 404, `Cross-tenant membership revoke must return 404 (got ${crossTenantRevoke.status})`);
    assert.strictEqual(crossTenantRevoke.body?.code, "NOT_FOUND");

    const tenantBPrincipals = await req("GET", `/api/v2/admin/tenants/${GOLDEN_01.tenantB.id}/principals`, { token: admin1Token });
    assert.strictEqual(tenantBPrincipals.status, 200);
    const intactTenantB = (tenantBPrincipals.body.items || []).find((m: any) => m.membershipId === tenantBMembershipId);
    assert.ok(intactTenantB && intactTenantB.active === true && intactTenantB.validTo === null, "Tenant B membership must remain untouched after cross-tenant revoke attempt");
  });

  await check("Platform Users: shared names rejected (400); OPS_SUPPORT immediate; SUPER_ADMIN four-eyes, reject & minimum-2 deadlock guard", async () => {
    const shared = await req("POST", "/api/v2/admin/platform-users", {
      token: admin1Token,
      body: { subject: "admin@zoikoabate.dev", displayName: "Shared Admin", platformRole: "OPS_SUPPORT", reason: "Should fail" }
    });
    assert.strictEqual(shared.status, 400, "Shared/generic platform account names must be rejected");

    // Four-eyes deadlock guard: when only 2 active named SUPER_ADMINs exist, disabling or demoting either MUST fail 409 CONFLICT
    const seededSuperAdmin2Id = "00000000-0000-4000-f001-000000000002";
    const puBefore = await req("GET", "/api/v2/admin/platform-users", { token: admin1Token });
    assert.strictEqual(puBefore.status, 200);
    const activeNamedCount = (puBefore.body.items || []).filter(
      (u: any) => u.platformRole === "SUPER_ADMIN" && u.status === "ACTIVE" && !u.breakGlass
    ).length;
    if (activeNamedCount <= 2) {
      const deadlockDisable = await req("POST", `/api/v2/admin/platform-users/${seededSuperAdmin2Id}/disable`, {
        token: admin1Token,
        body: { reason: "Testing four-eyes deadlock guard on disable" }
      });
      assert.strictEqual(deadlockDisable.status, 409, `Disabling SUPER_ADMIN below 2 active named admins must return 409 (got ${deadlockDisable.status})`);
      assert.match(String(deadlockDisable.body?.message || ""), /deadlock/i);

      const deadlockDemote = await req("PATCH", `/api/v2/admin/platform-users/${seededSuperAdmin2Id}/role`, {
        token: admin1Token,
        body: { platformRole: "OPS_SUPPORT", reason: "Testing four-eyes deadlock guard on demote" }
      });
      assert.strictEqual(deadlockDemote.status, 409, `Demoting SUPER_ADMIN below 2 active named admins must return 409 (got ${deadlockDemote.status})`);
      assert.match(String(deadlockDemote.body?.message || ""), /deadlock/i);
    }

    const opsCreated = await req("POST", "/api/v2/admin/platform-users", {
      token: admin1Token,
      body: { subject: `claire.ops.${suffix}@zoikoabate.dev`, displayName: "Claire Ops", platformRole: "OPS_SUPPORT", reason: "New ops responder" }
    });
    assert.strictEqual(opsCreated.status, 201);

    const opsDisabled = await req("POST", `/api/v2/admin/platform-users/${opsCreated.body.id}/disable`, {
      token: admin1Token,
      body: { reason: "Completed temporary rotation" }
    });
    assert.strictEqual(opsDisabled.status, 200);
    assert.strictEqual(opsDisabled.body.status, "DISABLED");

    const saReq = await req("POST", "/api/v2/admin/platform-users", {
      token: admin1Token,
      body: { subject: `dan.super.${suffix}@zoikoabate.dev`, displayName: "Dan Super", platformRole: "SUPER_ADMIN", reason: "New super admin candidate" }
    });
    assert.strictEqual(saReq.status, 202);

    const saRejected = await req("POST", `/api/v2/admin/approvals/${saReq.body.approvalRequest.id}/reject`, {
      token: admin2Token,
      body: { reason: "Awaiting security owner sign-off" }
    });
    assert.strictEqual(saRejected.status, 200);
    assert.strictEqual(saRejected.body.status, "REJECTED");
  });

  await check("Feature flags, entitlements (privacy override refused 403), AI quota, kill switches, and operations", async () => {
    // Feature flag enable -> four-eyes 202 -> Admin #2 approves -> 200; disable -> immediate 200
    const ffBad = await req("POST", "/api/v2/admin/feature-flags", {
      token: admin1Token,
      body: { tenantId: createdTenantId, flag: "planeBOutcomes", enabled: true, reason: "Strict test", extraField: true }
    });
    assert.strictEqual(ffBad.status, 400);

    const ffReq = await req("POST", "/api/v2/admin/feature-flags", {
      token: admin1Token,
      body: { tenantId: createdTenantId, flag: "planeBOutcomes", enabled: true, reason: "Enable Plane B pilot flag" }
    });
    assert.strictEqual(ffReq.status, 202);
    const ffApprove = await req("POST", `/api/v2/admin/approvals/${ffReq.body.approvalRequest.id}/approve`, {
      token: admin2Token,
      body: { reason: "Approved Plane B pilot flag" }
    });
    assert.strictEqual(ffApprove.status, 200);
    assert.strictEqual(ffApprove.body.result.enabled, true);

    const ffDisable = await req("POST", "/api/v2/admin/feature-flags", {
      token: admin1Token,
      body: { tenantId: createdTenantId, flag: "planeBOutcomes", enabled: false, reason: "Reverting flag after test" }
    });
    assert.strictEqual(ffDisable.status, 200);
    assert.strictEqual(ffDisable.body.enabled, false);

    // Entitlements refuse privacy-floor override keys (403)
    const badEnt = await req("POST", "/api/v2/admin/entitlements", {
      token: admin1Token,
      body: { tenantId: createdTenantId, featureKey: "PRIVACY_FLOOR_OVERRIDE", enabled: true, reason: "Should be refused" }
    });
    assert.strictEqual(badEnt.status, 403, "Privacy-floor entitlement override must be refused 403");

    const goodEnt = await req("POST", "/api/v2/admin/entitlements", {
      token: admin1Token,
      body: { tenantId: createdTenantId, featureKey: "EXTENDED_AUDIT_EXPORT", enabled: true, notes: "Pilot tier", reason: "Commercial tier grant" }
    });
    assert.strictEqual(goodEnt.status, 200);

    const entList = await req("GET", `/api/v2/admin/entitlements?tenantId=${createdTenantId}`, { token: admin1Token });
    assert.strictEqual(entList.status, 200);
    assert.ok(entList.body.items.some((e: any) => e.featureKey === "EXTENDED_AUDIT_EXPORT" && e.enabled));

    // AI Quota update + stale If-Match check
    const qSet = await req("PUT", `/api/v2/admin/tenants/${createdTenantId}/ai-quota`, {
      token: admin1Token,
      body: { monthlyBudgetMinor: 75000, reason: "Pilot budget adjustment" }
    });
    assert.strictEqual(qSet.status, 200);
    assert.strictEqual(qSet.body.monthlyBudgetMinor, 75000);

    const qStale = await req("PUT", `/api/v2/admin/tenants/${createdTenantId}/ai-quota`, {
      token: admin1Token,
      headers: { "if-match": '"999"' },
      body: { monthlyBudgetMinor: 80000, reason: "Stale quota update" }
    });
    assert.strictEqual(qStale.status, 409);

    // Governed kill switch (four-eyes activate then clean deactivate)
    const ksReq = await req("POST", "/api/v2/admin/kill-switches", {
      token: admin1Token,
      body: {
        scope: "use_case:EXPLAIN_RELEASE",
        active: true,
        reason: "Testing governed kill switch activation",
        expiresAt: new Date(Date.now() + 3600_000).toISOString()
      }
    });
    assert.strictEqual(ksReq.status, 202);
    const ksApp = await req("POST", `/api/v2/admin/approvals/${ksReq.body.approvalRequest.id}/approve`, {
      token: admin2Token,
      body: { reason: "Approved kill switch drill" }
    });
    assert.strictEqual(ksApp.status, 200);
    assert.strictEqual(ksApp.body.result.active, true);

    const ksReset = await req("POST", "/api/v2/admin/kill-switches", {
      token: admin1Token,
      body: { scope: "use_case:EXPLAIN_RELEASE", active: false, reason: "Restoring switch after drill" }
    });
    assert.strictEqual(ksReset.status, 202);
    const ksResetApp = await req("POST", `/api/v2/admin/approvals/${ksReset.body.approvalRequest.id}/approve`, {
      token: admin2Token,
      body: { reason: "Approved restore after drill" }
    });
    assert.strictEqual(ksResetApp.status, 200);

    // Operations content-free summary
    const ops = await req("GET", "/api/v2/admin/operations", { token: admin1Token });
    assert.strictEqual(ops.status, 200);
    assert.ok(ops.body.worker && typeof ops.body.queueDepth === "number" && Array.isArray(ops.body.connectors));
  });

  await check("Immutable platform audit log captures operator, approver, reason, request_id, principals view, and audited export", async () => {
    const audit = await req("GET", "/api/v2/admin/audit?limit=200", { token: admin1Token });
    assert.strictEqual(audit.status, 200);
    const items = audit.body.items as any[];

    const createEvt = items.find((a) => a.action === "tenant.create" && a.target_id === createdTenantId);
    assert.ok(createEvt && createEvt.operator === "alice.admin@zoikoabate.dev" && createEvt.reason && createEvt.request_id);

    const suspendEvt = items.find((a) => a.action === "tenant.suspend" && a.target_id === createdTenantId);
    assert.ok(suspendEvt, "tenant.suspend must be audited");
    assert.strictEqual(suspendEvt.operator, "alice.admin@zoikoabate.dev");
    assert.strictEqual(suspendEvt.approver, "bob.admin@zoikoabate.dev");
    assert.strictEqual(Boolean(suspendEvt.step_up_verified), true);

    assert.ok(items.some((a) => a.action === "tenant.principals.viewed" && a.target_id === createdTenantId), "Principal list views must be audited");
    assert.ok(items.some((a) => a.action === "membership.revoke"), "Membership revocation must be audited");

    const expJson = await req("POST", "/api/v2/admin/audit/export", {
      token: admin1Token,
      body: { format: "json", reason: "Quarterly governance evidence export" }
    });
    assert.strictEqual(expJson.status, 200);
    assert.ok(expJson.body.count >= 5);

    const expCsv = await req("POST", "/api/v2/admin/audit/export", {
      token: admin1Token,
      body: { format: "csv", reason: "Compliance CSV review" }
    });
    assert.strictEqual(expCsv.status, 200);
    assert.ok(String(expCsv.raw).startsWith("id,occurred_at,operator,approver,role,action"));

    const afterExport = await req("GET", "/api/v2/admin/audit?action=platform_audit.export", { token: admin1Token });
    assert.strictEqual(afterExport.status, 200);
    assert.ok(afterExport.body.items.length >= 2, "Audit exports must themselves be logged to platform_audit_event");
  });

  await check("Hardened OIDC staging mode: dev token route returns 404, MFA (amr) and IdP auth_time step-up enforced end-to-end without HS256 dev tokens", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const prevDisableDev = process.env.ABATE_DISABLE_DEV_TOKEN;
    const prevOidcPem = process.env.OIDC_PUBLIC_KEY_PEM;
    try {
      process.env.ABATE_DISABLE_DEV_TOKEN = "1";
      process.env.OIDC_PUBLIC_KEY_PEM = publicKey;
      resetConfigCache();
      const hardenedCfg = loadConfig();
      const supportAud = `${hardenedCfg.authAudience}:support`;
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Dev super-admin token endpoint returns 404 when dev tokens are disabled
      const devRouteBlocked = await req("POST", "/api/v2/auth/super-admin-token", {
        body: { operator: "alice.admin@zoikoabate.dev", stepUp: true }
      });
      assert.strictEqual(devRouteBlocked.status, 404, "POST /api/v2/auth/super-admin-token must return 404 when dev tokens are disabled");

      // 2. HS256 dev bearer token is rejected 401
      const devTokenBlocked = await req("GET", "/api/v2/admin/me", { token: admin1Token });
      assert.strictEqual(devTokenBlocked.status, 401, "HS256 dev token must be rejected when dev tokens are disabled");

      // 3. RS256 OIDC JWT WITHOUT MFA amr/acr claim is rejected 401
      const noMfaJwt = jwt.sign(
        { sub: "alice.oidc@zoikoabate.dev", scope: SUPER_ADMIN_SCOPE, auth_time: nowSec },
        privateKey,
        { algorithm: "RS256", issuer: hardenedCfg.authIssuer, audience: supportAud, expiresIn: "15m" }
      );
      const noMfaMe = await req("GET", "/api/v2/admin/me", { token: noMfaJwt });
      assert.strictEqual(noMfaMe.status, 401, "OIDC Super Admin JWT without MFA amr/acr must be rejected 401");
      const noMfaExchange = await req("POST", "/api/v2/admin/session/oidc/exchange", { body: { idToken: noMfaJwt } });
      assert.strictEqual(noMfaExchange.status, 401, "OIDC exchange without MFA amr/acr must be rejected 401");

      // 4. RS256 OIDC JWT WITH amr:["mfa"] but stale auth_time (even with spoofed step_up_at) -> read/exchange allowed, destructive action & stale step-up rejected 401
      const staleOidcJwt = jwt.sign(
        {
          sub: "alice.oidc@zoikoabate.dev",
          scope: SUPER_ADMIN_SCOPE,
          amr: ["pwd", "mfa"],
          auth_time: nowSec - (hardenedCfg.adminStepUpWindowSeconds + 300),
          step_up_at: nowSec
        },
        privateKey,
        { algorithm: "RS256", issuer: hardenedCfg.authIssuer, audience: supportAud, expiresIn: "15m" }
      );
      const exch = await req("POST", "/api/v2/admin/session/oidc/exchange", { body: { idToken: staleOidcJwt } });
      assert.strictEqual(exch.status, 200, `OIDC exchange failed: ${exch.raw}`);
      assert.strictEqual(exch.body.authMethod, "oidc");
      assert.strictEqual(exch.body.mfaVerified, true);
      assert.strictEqual(exch.body.stepUpVerified, false, "OIDC mode must trust IdP auth_time and ignore spoofed step_up_at");
      const setCookie1 = exch.headers["set-cookie"] || "";
      const sessMatch1 = setCookie1.match(/abate_admin_session=([^;\s,]+)/);
      const csrfMatch1 = setCookie1.match(/abate_admin_csrf=([^;\s,]+)/);
      assert.ok(sessMatch1 && csrfMatch1, "OIDC exchange must set abate_admin_session and abate_admin_csrf cookies");
      const staleCookieHeader = `abate_admin_session=${sessMatch1[1]}; abate_admin_csrf=${csrfMatch1[1]}`;
      const staleCsrf = decodeURIComponent(csrfMatch1[1]);

      const oidcMe = await req("GET", "/api/v2/admin/me", { headers: { cookie: staleCookieHeader } });
      assert.strictEqual(oidcMe.status, 200);
      assert.strictEqual(oidcMe.body.authMethod, "oidc");
      assert.strictEqual(oidcMe.body.stepUpVerified, false);

      const staleDestructive = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
        headers: { cookie: staleCookieHeader, "x-admin-csrf": staleCsrf },
        body: { state: "SUSPENDED", reason: "OIDC stale auth_time test" }
      });
      assert.strictEqual(staleDestructive.status, 401, "Destructive action with stale IdP auth_time must fail 401");

      const staleStepUpAttempt = await req("POST", "/api/v2/admin/session/step-up", {
        headers: { cookie: staleCookieHeader, "x-admin-csrf": staleCsrf },
        body: { confirmation: "CANNOT-BYPASS-IN-HARDENED-MODE" }
      });
      assert.strictEqual(staleStepUpAttempt.status, 401, "Local confirmation string must NOT bypass IdP auth_time step-up in hardened mode");

      // 5. Fresh RS256 OIDC JWT with amr:["mfa","hwk"] + recent auth_time -> upgrades OIDC cookie session without minting any HS256 dev token
      const freshOidcJwt = jwt.sign(
        {
          sub: "alice.oidc@zoikoabate.dev",
          scope: SUPER_ADMIN_SCOPE,
          amr: ["mfa", "hwk"],
          auth_time: nowSec
        },
        privateKey,
        { algorithm: "RS256", issuer: hardenedCfg.authIssuer, audience: supportAud, expiresIn: "15m" }
      );
      const freshStepUp = await req("POST", "/api/v2/admin/session/step-up", {
        headers: { cookie: staleCookieHeader, "x-admin-csrf": staleCsrf },
        body: { idToken: freshOidcJwt }
      });
      assert.strictEqual(freshStepUp.status, 200, `Hardened OIDC step-up failed: ${freshStepUp.raw}`);
      assert.strictEqual(freshStepUp.body.verified, true);
      assert.strictEqual(freshStepUp.body.authMethod, "oidc");
      assert.strictEqual("token" in freshStepUp.body, false, "Hardened OIDC step-up must never mint an HS256 dev token");

      const setCookie2 = freshStepUp.headers["set-cookie"] || "";
      const sessMatch2 = setCookie2.match(/abate_admin_session=([^;\s,]+)/);
      const csrfMatch2 = setCookie2.match(/abate_admin_csrf=([^;\s,]+)/);
      assert.ok(sessMatch2 && csrfMatch2, "Hardened OIDC step-up must rotate admin session cookies");
      const freshCookieHeader = `abate_admin_session=${sessMatch2[1]}; abate_admin_csrf=${csrfMatch2[1]}`;
      const freshCsrf = decodeURIComponent(csrfMatch2[1]);

      const oidcDestructive = await req("POST", `/api/v2/admin/tenants/${createdTenantId}/state`, {
        headers: { cookie: freshCookieHeader, "x-admin-csrf": freshCsrf },
        body: { state: "SUSPENDED", reason: "Hardened OIDC step-up verified suspend request" }
      });
      assert.strictEqual(oidcDestructive.status, 202, `Fresh OIDC step-up cookie should queue four-eyes 202 (got ${oidcDestructive.status}: ${oidcDestructive.raw})`);
      assert.strictEqual(oidcDestructive.body.status, "PENDING_APPROVAL");
    } finally {
      if (prevDisableDev === undefined) delete process.env.ABATE_DISABLE_DEV_TOKEN;
      else process.env.ABATE_DISABLE_DEV_TOKEN = prevDisableDev;
      if (prevOidcPem === undefined) delete process.env.OIDC_PUBLIC_KEY_PEM;
      else process.env.OIDC_PUBLIC_KEY_PEM = prevOidcPem;
      resetConfigCache();
    }
  });

  console.log(`\n\x1b[32m✔ Hardened Super Admin Suite PASSED (${passed} checks).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[SUPER-ADMIN TEST FAILED]\x1b[0m", err);
  process.exit(1);
});
