// backend/tools/test-admin-matrix.ts
// Complete Authorization Matrix, Privilege-Escalation, Four-Eyes & Cross-Tenant Isolation Suite
// Covers every /api/v2/admin/* and /api/v2/tenant-admin/* route across 6 actor tiers:
//   ANON, TENANT_VIEWER, TENANT_RISK_OWNER, TENANT_EMPLOYER_ADMIN, OPS_SUPPORT, SUPER_ADMIN
// Plus:
//   - Privilege escalation refusals (Super Admin -> approval roles/tenant data; EMPLOYER_ADMIN -> approve/disposition)
//   - Tenant Admin cross-tenant 404 parity (foreign Tenant B IDs vs nonexistent UUIDs)
//   - Tenant Admin full lifecycle (effective-dated memberships, deactivate/reactivate, OIDC invites, org edit, own audit, usage)

import assert from "node:assert";
import crypto from "node:crypto";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, requireSeparationOfDuties } from "../src/domains/tenant/auth";
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

type ActorKey =
  | "ANON"
  | "TENANT_VIEWER"
  | "TENANT_RISK_OWNER"
  | "TENANT_EMPLOYER_ADMIN"
  | "OPS_SUPPORT"
  | "SUPER_ADMIN";

interface MatrixRow {
  label: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
  needsIdempotency?: boolean;
  expected: Record<ActorKey, number[]>;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000099";

async function main() {
  console.log("\x1b[36m=== Abate Admin & Tenant-Admin Authorization Matrix Suite (test-admin-matrix) ===\x1b[0m\n");
  const cfg = loadConfig();
  const suffix = crypto.randomUUID().slice(0, 8);
  const seeded = await seedTwoTenants({ clock: new Date(cfg.fixedClock), persistToPostgres: isPostgresRequired() });
  const tenantARootOrgId = seeded.tenantA.org.id;
  const tenantBRootOrgId = seeded.tenantB.org.id;

  const admin1Token = createSuperAdminToken({
    operator: "alice.admin@zoikoabate.dev",
    stepUpAt: Math.floor(Date.now() / 1000)
  });
  const admin2Token = createSuperAdminToken({
    operator: "bob.admin@zoikoabate.dev",
    stepUpAt: Math.floor(Date.now() / 1000)
  });
  const supportToken = createSupportToken({ operator: "ops.support@zoikoabate.dev" });

  // Bootstrap pure EMPLOYER_ADMIN accounts in Tenant A and Tenant B so their DB roles strictly equal EMPLOYER_ADMIN
  const taAdminSub = `tenant.a.admin.${suffix}@apex.example`;
  const tbAdminSub = `tenant.b.admin.${suffix}@beacon.example`;
  const taBoot = await expressCall("POST", `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}/memberships`, {
    token: admin1Token,
    body: { externalSubject: taAdminSub, kind: "USER", domainRole: "EMPLOYER_ADMIN", reason: "Matrix test bootstrap Tenant A" }
  });
  assert.strictEqual(taBoot.status, 201, `Tenant A EMPLOYER_ADMIN bootstrap failed: ${taBoot.raw}`);

  const tbBoot = await expressCall("POST", `/api/v2/admin/tenants/${GOLDEN_01.tenantB.id}/memberships`, {
    token: admin1Token,
    body: { externalSubject: tbAdminSub, kind: "USER", domainRole: "EMPLOYER_ADMIN", reason: "Matrix test bootstrap Tenant B" }
  });
  assert.strictEqual(tbBoot.status, 201, `Tenant B EMPLOYER_ADMIN bootstrap failed: ${tbBoot.raw}`);

  const tenantAEmployerAdminToken = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: taAdminSub,
    role: "EMPLOYER_ADMIN"
  });
  const tenantBEmployerAdminToken = createDevToken({
    tenantId: GOLDEN_01.tenantB.id,
    subject: tbAdminSub,
    role: "EMPLOYER_ADMIN"
  });
  const tenantARiskOwnerToken = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });

  // Provision a pure VIEWER principal in Tenant A
  const viewerSub = `tenant.a.viewer.${suffix}@apex.example`;
  const viewerCreated = await expressCall("POST", "/api/v2/tenant-admin/memberships", {
    token: tenantAEmployerAdminToken,
    headers: { "idempotency-key": `idem-viewer-${suffix}` },
    body: {
      externalSubject: viewerSub,
      kind: "USER",
      organizationId: tenantARootOrgId,
      domainRole: "VIEWER",
      reason: "Matrix test viewer account"
    }
  });
  assert.ok([200, 201].includes(viewerCreated.status), `Viewer setup failed: ${viewerCreated.raw}`);

  const tenantAViewerToken = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: viewerSub,
    role: "VIEWER"
  });

  // Create a disposable Tenant A org and Tenant B invitation/user for matrix & cross-tenant probes
  const disposableOrg = await expressCall("POST", "/api/v2/organizations", {
    token: tenantAEmployerAdminToken,
    headers: { "idempotency-key": `idem-disp-org-${suffix}` },
    body: { name: `Matrix Org ${suffix}`, parentId: tenantARootOrgId }
  });
  assert.ok([200, 201].includes(disposableOrg.status));
  const disposableOrgId = disposableOrg.body.id;

  const tenantBInvite = await expressCall("POST", "/api/v2/tenant-admin/invitations", {
    token: tenantBEmployerAdminToken,
    headers: { "idempotency-key": `idem-tb-inv-${suffix}` },
    body: {
      email: `invite.b.${suffix}@beacon.example`,
      organizationId: tenantBRootOrgId,
      domainRole: "REVIEWER",
      reason: "Cross-tenant isolation fixture"
    }
  });
  assert.ok([200, 201].includes(tenantBInvite.status), `Tenant B invite fixture failed: ${tenantBInvite.raw}`);

  const tokens: Record<ActorKey, string | undefined> = {
    ANON: undefined,
    TENANT_VIEWER: tenantAViewerToken,
    TENANT_RISK_OWNER: tenantARiskOwnerToken,
    TENANT_EMPLOYER_ADMIN: tenantAEmployerAdminToken,
    OPS_SUPPORT: supportToken,
    SUPER_ADMIN: admin1Token
  };

  // Explicit repository-resident authorization matrix covering every /api/v2/admin/* & /api/v2/tenant-admin/* route
  const ENDPOINT_MATRIX: MatrixRow[] = [
    // --- Platform Super Admin Read Routes ---
    {
      label: "GET /api/v2/admin/me",
      method: "GET",
      path: "/api/v2/admin/me",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/overview",
      method: "GET",
      path: "/api/v2/admin/overview",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/tenants",
      method: "GET",
      path: "/api/v2/admin/tenants",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/tenants/:tenantId",
      method: "GET",
      path: `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}`,
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/tenants/:tenantId/principals",
      method: "GET",
      path: `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}/principals`,
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/platform-users",
      method: "GET",
      path: "/api/v2/admin/platform-users",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/approvals",
      method: "GET",
      path: "/api/v2/admin/approvals",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/governance",
      method: "GET",
      path: "/api/v2/admin/governance",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/feature-flags",
      method: "GET",
      path: "/api/v2/admin/feature-flags",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/entitlements",
      method: "GET",
      path: "/api/v2/admin/entitlements",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/ai-quota",
      method: "GET",
      path: "/api/v2/admin/ai-quota",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/operations",
      method: "GET",
      path: "/api/v2/admin/operations",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "GET /api/v2/admin/audit",
      method: "GET",
      path: "/api/v2/admin/audit",
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    // --- Platform Super Admin Mutation Routes ---
    {
      label: "POST /api/v2/admin/session/step-up",
      method: "POST",
      path: "/api/v2/admin/session/step-up",
      body: { confirmation: "MATRIX-CONFIRM" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "POST /api/v2/admin/tenants",
      method: "POST",
      path: "/api/v2/admin/tenants",
      body: { name: `Matrix Created ${suffix}`, region: "eu-west-2", sectorKey: "GENERIC", reason: "Matrix authorization test" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [201] }
    },
    {
      label: "PATCH /api/v2/admin/tenants/:tenantId (nonexistent -> 404 for SA)",
      method: "PATCH",
      path: `/api/v2/admin/tenants/${ZERO_UUID}`,
      body: { name: "Noop", region: "eu-west-2", reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/tenants/:tenantId/state (nonexistent -> 404 for SA)",
      method: "POST",
      path: `/api/v2/admin/tenants/${ZERO_UUID}/state`,
      body: { state: "SUSPENDED", reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/tenants/:tenantId/offboard-request (nonexistent -> 404 for SA)",
      method: "POST",
      path: `/api/v2/admin/tenants/${ZERO_UUID}/offboard-request`,
      body: { reason: "Matrix offboard probe reason" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "PUT /api/v2/admin/tenants/:tenantId/sector-pack (nonexistent -> 404 for SA)",
      method: "PUT",
      path: `/api/v2/admin/tenants/${ZERO_UUID}/sector-pack`,
      body: { sectorKey: "GENERIC", reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/tenants/:tenantId/memberships/:id/revoke (nonexistent -> 404 for SA)",
      method: "POST",
      path: `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}/memberships/${ZERO_UUID}/revoke`,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/platform-users",
      method: "POST",
      path: "/api/v2/admin/platform-users",
      body: { subject: `matrix.ops.${suffix}@zoikoabate.dev`, displayName: "Matrix Ops", platformRole: "OPS_SUPPORT", reason: "Matrix auth probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [201] }
    },
    {
      label: "PATCH /api/v2/admin/platform-users/:id/role (nonexistent -> 404 for SA)",
      method: "PATCH",
      path: `/api/v2/admin/platform-users/${ZERO_UUID}/role`,
      body: { platformRole: "OPS_SUPPORT", reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/platform-users/:id/disable (nonexistent -> 404 for SA)",
      method: "POST",
      path: `/api/v2/admin/platform-users/${ZERO_UUID}/disable`,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/approvals/:id/approve (nonexistent -> 404 for SA)",
      method: "POST",
      path: `/api/v2/admin/approvals/${ZERO_UUID}/approve`,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/approvals/:id/reject (nonexistent -> 404 for SA)",
      method: "POST",
      path: `/api/v2/admin/approvals/${ZERO_UUID}/reject`,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [404] }
    },
    {
      label: "POST /api/v2/admin/feature-flags (disable -> 200 for SA)",
      method: "POST",
      path: "/api/v2/admin/feature-flags",
      body: { tenantId: GOLDEN_01.tenantA.id, flag: "aiWorkDesign", enabled: false, reason: "Matrix flag probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "POST /api/v2/admin/entitlements",
      method: "POST",
      path: "/api/v2/admin/entitlements",
      body: { tenantId: GOLDEN_01.tenantA.id, featureKey: "MATRIX_ENTITLEMENT_CHECK", enabled: true, reason: "Matrix entitlement probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "PUT /api/v2/admin/tenants/:tenantId/ai-quota",
      method: "PUT",
      path: `/api/v2/admin/tenants/${GOLDEN_01.tenantA.id}/ai-quota`,
      body: { monthlyBudgetMinor: 50000, reason: "Matrix quota probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    {
      label: "POST /api/v2/admin/kill-switches (four-eyes -> 202 for SA)",
      method: "POST",
      path: "/api/v2/admin/kill-switches",
      body: { scope: "use_case:DRAFT_CONTROL", active: false, reason: "Matrix kill-switch probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [202] }
    },
    {
      label: "POST /api/v2/admin/audit/export",
      method: "POST",
      path: "/api/v2/admin/audit/export",
      body: { format: "json", reason: "Matrix audit export probe" },
      expected: { ANON: [401], TENANT_VIEWER: [401], TENANT_RISK_OWNER: [401], TENANT_EMPLOYER_ADMIN: [401], OPS_SUPPORT: [403], SUPER_ADMIN: [200] }
    },
    // --- Tenant Admin Read Routes ---
    {
      label: "GET /api/v2/tenant-admin/users",
      method: "GET",
      path: "/api/v2/tenant-admin/users",
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "GET /api/v2/tenant-admin/users/:principalId",
      method: "GET",
      path: `/api/v2/tenant-admin/users/${taBoot.body.principalId}`,
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "GET /api/v2/tenant-admin/invitations",
      method: "GET",
      path: "/api/v2/tenant-admin/invitations",
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "GET /api/v2/tenant-admin/audit",
      method: "GET",
      path: "/api/v2/tenant-admin/audit",
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "GET /api/v2/tenant-admin/rights-requests",
      method: "GET",
      path: "/api/v2/tenant-admin/rights-requests",
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "GET /api/v2/tenant-admin/usage",
      method: "GET",
      path: "/api/v2/tenant-admin/usage",
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    // --- Tenant Admin Mutation Routes (strictly EMPLOYER_ADMIN for user/membership/invite ops) ---
    {
      label: "POST /api/v2/tenant-admin/users/:id/deactivate (nonexistent -> 404 for EMPLOYER_ADMIN)",
      method: "POST",
      path: `/api/v2/tenant-admin/users/${ZERO_UUID}/deactivate`,
      needsIdempotency: true,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [403], TENANT_EMPLOYER_ADMIN: [404], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "POST /api/v2/tenant-admin/users/:id/reactivate (nonexistent -> 404 for EMPLOYER_ADMIN)",
      method: "POST",
      path: `/api/v2/tenant-admin/users/${ZERO_UUID}/reactivate`,
      needsIdempotency: true,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [403], TENANT_EMPLOYER_ADMIN: [404], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "POST /api/v2/tenant-admin/memberships",
      method: "POST",
      path: "/api/v2/tenant-admin/memberships",
      needsIdempotency: true,
      body: {
        externalSubject: `matrix.member.${suffix}@apex.example`,
        kind: "USER",
        organizationId: tenantARootOrgId,
        domainRole: "REVIEWER",
        reason: "Matrix membership grant"
      },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [403], TENANT_EMPLOYER_ADMIN: [200, 201], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "POST /api/v2/tenant-admin/memberships/:id/end (nonexistent -> 404 for EMPLOYER_ADMIN)",
      method: "POST",
      path: `/api/v2/tenant-admin/memberships/${ZERO_UUID}/end`,
      needsIdempotency: true,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [403], TENANT_EMPLOYER_ADMIN: [404], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "POST /api/v2/tenant-admin/invitations",
      method: "POST",
      path: "/api/v2/tenant-admin/invitations",
      needsIdempotency: true,
      body: {
        email: `matrix.invite.${suffix}@apex.example`,
        organizationId: tenantARootOrgId,
        domainRole: "REVIEWER",
        reason: "Matrix invite test"
      },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [403], TENANT_EMPLOYER_ADMIN: [200, 201], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "POST /api/v2/tenant-admin/invitations/:id/revoke (nonexistent -> 404 for EMPLOYER_ADMIN)",
      method: "POST",
      path: `/api/v2/tenant-admin/invitations/${ZERO_UUID}/revoke`,
      needsIdempotency: true,
      body: { reason: "Matrix probe" },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [403], TENANT_EMPLOYER_ADMIN: [404], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    },
    {
      label: "PATCH /api/v2/tenant-admin/organizations/:orgId",
      method: "PATCH",
      path: `/api/v2/tenant-admin/organizations/${disposableOrgId}`,
      needsIdempotency: true,
      body: { name: `Matrix Org Renamed ${suffix}`, reason: "Matrix org update" },
      expected: { ANON: [401], TENANT_VIEWER: [403], TENANT_RISK_OWNER: [200], TENANT_EMPLOYER_ADMIN: [200], OPS_SUPPORT: [401], SUPER_ADMIN: [401] }
    }
  ];

  await check(`Authorization matrix table (${ENDPOINT_MATRIX.length} endpoints × 6 actor tiers = ${ENDPOINT_MATRIX.length * 6} assertions)`, async () => {
    const actors: ActorKey[] = ["ANON", "TENANT_VIEWER", "TENANT_RISK_OWNER", "TENANT_EMPLOYER_ADMIN", "OPS_SUPPORT", "SUPER_ADMIN"];
    for (const row of ENDPOINT_MATRIX) {
      for (const actor of actors) {
        const headers: Record<string, string> = {};
        if (row.needsIdempotency) {
          headers["idempotency-key"] = `matrix-${crypto.randomUUID()}`;
        }
        const res = await expressCall(row.method, row.path, {
          token: tokens[actor],
          body: row.body,
          headers
        });
        assert.ok(
          row.expected[actor].includes(res.status),
          `[MATRIX FAIL] ${row.label} as ${actor}: expected ${row.expected[actor].join("/")}, got ${res.status} (${res.raw.slice(0, 180)})`
        );
      }
    }
  });

  await check("Privilege Escalation: EMPLOYER_ADMIN cannot approve controls or set hazard disposition; SUPER_ADMIN cannot touch tenant business data", async () => {
    // 1. Draft a fresh PROPOSED control on the seeded Tenant A hazard & accepted cause as RISK_OWNER so we hit authorization (not 404)
    const hazardId = GOLDEN_01.approvedControl.hazardId;
    const ctrl = await expressCall("POST", "/api/v2/controls", {
      token: tenantARiskOwnerToken,
      headers: { "idempotency-key": `idem-ctrl-esc-${suffix}` },
      body: {
        hazardId,
        causeId: GOLDEN_01.approvedControl.causeId,
        scope: "Unit handoff schedule",
        objective: "Eliminate unscheduled late-evening handoffs",
        dueDate: "2026-06-30",
        verificationPlan: { primaryMetric: "BOUNDARY_INTRUSION_SHARE", minDays: 28 }
      }
    });
    assert.ok([200, 201].includes(ctrl.status), `Control creation failed: ${ctrl.raw}`);
    const controlId = ctrl.body.id;

    // EMPLOYER_ADMIN (without APPROVER/RISK_OWNER) MUST be refused 403 on control.approve & hazard.disposition
    const adminApproveCtrl = await expressCall("POST", `/api/v2/controls/${controlId}/approve`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `idem-adm-app-${suffix}`, "if-match": '"1"' },
      body: { note: "Tenant admin attempting approval" }
    });
    assert.strictEqual(adminApproveCtrl.status, 403, `Pure EMPLOYER_ADMIN must be refused control.approve (got ${adminApproveCtrl.status})`);

    const adminDispHaz = await expressCall("POST", `/api/v2/hazards/${hazardId}/disposition`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `idem-adm-disp-${suffix}` },
      body: { disposition: "CLOSED", rationale: "Tenant admin attempting hazard disposition" }
    });
    assert.strictEqual(adminDispHaz.status, 403, `Pure EMPLOYER_ADMIN must be refused hazard.disposition (got ${adminDispHaz.status})`);

    // SUPER_ADMIN attempting to approve control, set disposition, read hazard, or read work facts -> 401
    for (const [m, p, b] of [
      ["POST", `/api/v2/controls/${controlId}/approve`, { note: "Super admin hijack" }],
      ["POST", `/api/v2/hazards/${hazardId}/disposition`, { disposition: "CLOSED", rationale: "Super admin hijack" }],
      ["GET", `/api/v2/hazards/${hazardId}`, undefined],
      ["GET", "/api/v2/work-facts", undefined]
    ] as const) {
      const saTry = await expressCall(m, p, {
        token: admin2Token,
        headers: { "idempotency-key": `idem-sa-${crypto.randomUUID()}` },
        body: b
      });
      assert.strictEqual(saTry.status, 401, `SUPER_ADMIN must be rejected on ${m} ${p}`);
    }

    // /api/v2/me reflects allowedActions accurately (EMPLOYER_ADMIN lacks control.approve & hazard.disposition)
    const meAdmin = await expressCall("GET", "/api/v2/me", { token: tenantAEmployerAdminToken });
    assert.strictEqual(meAdmin.status, 200);
    assert.ok(meAdmin.body.allowedNav.includes("TENANT_ADMIN"));
    assert.ok(meAdmin.body.allowedActions.includes("tenant.users.manage"));
    assert.strictEqual(meAdmin.body.allowedActions.includes("control.approve"), false);
    assert.strictEqual(meAdmin.body.allowedActions.includes("hazard.disposition"), false);

    // /api/v2/ops/ai-quota works for OPS_SUPPORT without tenant-scoped business data
    const opsQuota = await expressCall("GET", "/api/v2/ops/ai-quota", { token: supportToken });
    assert.strictEqual(opsQuota.status, 200);
    assert.ok(Array.isArray(opsQuota.body.items));
  });

  await check("Tenant Admin Cross-Tenant Isolation: foreign Tenant B IDs return identical 404 NOT_FOUND to nonexistent IDs", async () => {
    const pairs: Array<[string, string, string, Record<string, unknown>?]> = [
      ["GET", `/api/v2/tenant-admin/users/${tbBoot.body.principalId}`, `/api/v2/tenant-admin/users/${ZERO_UUID}`],
      ["POST", `/api/v2/tenant-admin/users/${tbBoot.body.principalId}/deactivate`, `/api/v2/tenant-admin/users/${ZERO_UUID}/deactivate`, { reason: "Cross-tenant test" }],
      ["POST", `/api/v2/tenant-admin/memberships/${tbBoot.body.membershipId}/end`, `/api/v2/tenant-admin/memberships/${ZERO_UUID}/end`, { reason: "Cross-tenant test" }],
      ["POST", `/api/v2/tenant-admin/invitations/${tenantBInvite.body.id}/revoke`, `/api/v2/tenant-admin/invitations/${ZERO_UUID}/revoke`, { reason: "Cross-tenant test" }],
      ["PATCH", `/api/v2/tenant-admin/organizations/${tenantBRootOrgId}`, `/api/v2/tenant-admin/organizations/${ZERO_UUID}`, { name: "Hijack Org", reason: "Cross-tenant test" }]
    ];

    for (const [method, foreignPath, missingPath, body] of pairs) {
      const fRes = await expressCall(method, foreignPath, {
        token: tenantAEmployerAdminToken,
        headers: { "idempotency-key": `xtenant-f-${crypto.randomUUID()}` },
        body
      });
      const mRes = await expressCall(method, missingPath, {
        token: tenantAEmployerAdminToken,
        headers: { "idempotency-key": `xtenant-m-${crypto.randomUUID()}` },
        body
      });
      assert.strictEqual(fRes.status, 404, `Foreign ${method} ${foreignPath} must return 404, got ${fRes.status}`);
      assert.strictEqual(mRes.status, 404, `Missing ${method} ${missingPath} must return 404, got ${mRes.status}`);
      assert.strictEqual(fRes.body?.code, "NOT_FOUND");
      assert.strictEqual(mRes.body?.code, "NOT_FOUND");
      assert.strictEqual(fRes.body?.message, mRes.body?.message, "Foreign and missing 404 error messages must be identical");
    }
  });

  await check("Tenant Admin full lifecycle: effective-dated approver authority, deactivate/reactivate block, OIDC invite revoke, org If-Match, own audit & usage", async () => {
    const userSub = `lifecycle.approver.${suffix}@apex.example`;
    const assigned = await expressCall("POST", "/api/v2/tenant-admin/memberships", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-assign-${suffix}` },
      body: {
        externalSubject: userSub,
        kind: "USER",
        organizationId: tenantARootOrgId,
        domainRole: "APPROVER",
        reason: "Delegating control approval authority"
      }
    });
    assert.ok([200, 201].includes(assigned.status), `Assign membership failed: ${assigned.raw}`);
    assert.strictEqual(assigned.body.grantsApproverAuthority, true);
    const { principalId, membershipId } = assigned.body;

    // Deactivate user -> user token immediately refused (403)
    const userToken = createDevToken({ tenantId: GOLDEN_01.tenantA.id, subject: userSub, role: "APPROVER" });
    const beforeDeact = await expressCall("GET", "/api/v2/organizations", { token: userToken });
    assert.strictEqual(beforeDeact.status, 200);

    const staleDeact = await expressCall("POST", `/api/v2/tenant-admin/users/${principalId}/deactivate`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-deact-stale-${suffix}`, "if-match": '"999"' },
      body: { reason: "Testing stale version on deactivate" }
    });
    assert.strictEqual(staleDeact.status, 409);

    const deact = await expressCall("POST", `/api/v2/tenant-admin/users/${principalId}/deactivate`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-deact-${suffix}`, "if-match": '"1"' },
      body: { reason: "Temporary leave of absence" }
    });
    assert.strictEqual(deact.status, 200);
    assert.strictEqual(deact.body.active, false);

    const whileDeact = await expressCall("GET", "/api/v2/organizations", { token: userToken });
    assert.strictEqual(whileDeact.status, 403, "Deactivated principal must be refused API calls");

    const react = await expressCall("POST", `/api/v2/tenant-admin/users/${principalId}/reactivate`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-react-${suffix}`, "if-match": `"${deact.body.version}"` },
      body: { reason: "Returned from leave" }
    });
    assert.strictEqual(react.status, 200);
    assert.strictEqual(react.body.active, true);

    // End APPROVER membership -> rechecks remaining approver authority (false)
    const ended = await expressCall("POST", `/api/v2/tenant-admin/memberships/${membershipId}/end`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-end-${suffix}`, "if-match": '"1"' },
      body: { reason: "Rotation complete" }
    });
    assert.strictEqual(ended.status, 200);
    assert.strictEqual(ended.body.retainsApprovalAuthorityAfterEnd, false);

    // OIDC Invitation create, idempotency replay, revoke, double-revoke -> 409
    const invKey = `lc-inv-${suffix}`;
    const invBody = {
      email: `oidc.user.${suffix}@apex.example`,
      organizationId: tenantARootOrgId,
      domainRole: "CONTROL_OWNER",
      reason: "Onboarding control owner via OIDC"
    };
    const inv1 = await expressCall("POST", "/api/v2/tenant-admin/invitations", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": invKey },
      body: invBody
    });
    assert.ok([200, 201].includes(inv1.status), `Invite create failed: ${inv1.raw}`);
    const invReplay = await expressCall("POST", "/api/v2/tenant-admin/invitations", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": invKey },
      body: invBody
    });
    assert.strictEqual(invReplay.status, 200);
    assert.strictEqual(invReplay.body.id, inv1.body.id);

    const invRev = await expressCall("POST", `/api/v2/tenant-admin/invitations/${inv1.body.id}/revoke`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-inv-rev-${suffix}`, "if-match": '"1"' },
      body: { reason: "Invitation superseded" }
    });
    assert.strictEqual(invRev.status, 200);
    assert.strictEqual(invRev.body.status, "REVOKED");

    const invDoubleRev = await expressCall("POST", `/api/v2/tenant-admin/invitations/${inv1.body.id}/revoke`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-inv-rev2-${suffix}` },
      body: { reason: "Second revoke attempt" }
    });
    assert.strictEqual(invDoubleRev.status, 409);

    // Organization update self-parent rejected (400) & stale If-Match rejected (409)
    const selfParent = await expressCall("PATCH", `/api/v2/tenant-admin/organizations/${disposableOrgId}`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-org-sp-${suffix}` },
      body: { name: "Self Parent", parentId: disposableOrgId, reason: "Invalid cycle test" }
    });
    assert.strictEqual(selfParent.status, 400);

    const staleOrg = await expressCall("PATCH", `/api/v2/tenant-admin/organizations/${disposableOrgId}`, {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `lc-org-stale-${suffix}`, "if-match": '"999"' },
      body: { name: "Stale Org Name", reason: "Testing stale If-Match on org" }
    });
    assert.strictEqual(staleOrg.status, 409);

    // Searchable own audit only returns Tenant A events
    const ownAudit = await expressCall("GET", "/api/v2/tenant-admin/audit?command=tenant.invitation", {
      token: tenantAEmployerAdminToken
    });
    assert.strictEqual(ownAudit.status, 200);
    assert.strictEqual(ownAudit.body.tenantId, GOLDEN_01.tenantA.id);
    assert.ok(ownAudit.body.items.length >= 2);
    assert.ok(ownAudit.body.items.every((e: any) => !e.tenant_id || e.tenant_id === GOLDEN_01.tenantA.id));

    // Unified usage view
    const usage = await expressCall("GET", "/api/v2/tenant-admin/usage", { token: tenantAEmployerAdminToken });
    assert.strictEqual(usage.status, 200);
    assert.ok(usage.body.aiQuota && usage.body.entitlements && Array.isArray(usage.body.connections));
  });

  await check("Customer Separation of Duties: Tenant Admin cannot self-assign/self-invite APPROVER or RISK_OWNER; non-approval self-assign audited; owner cannot approve own control outside local/test", async () => {
    // 1. Self-assigning APPROVER by externalSubject -> 403
    const selfApproverSub = await expressCall("POST", "/api/v2/tenant-admin/memberships", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `sod-self-app-sub-${suffix}` },
      body: {
        externalSubject: taAdminSub,
        kind: "USER",
        organizationId: tenantARootOrgId,
        domainRole: "APPROVER",
        reason: "Testing separation of duties self-approver refusal"
      }
    });
    assert.strictEqual(selfApproverSub.status, 403, `Tenant Admin must be refused self-assigning APPROVER by subject (got ${selfApproverSub.status})`);

    // 2. Self-assigning RISK_OWNER by principalId -> 403
    const selfRiskOwnerId = await expressCall("POST", "/api/v2/tenant-admin/memberships", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `sod-self-ro-id-${suffix}` },
      body: {
        principalId: taBoot.body.principalId,
        kind: "USER",
        organizationId: tenantARootOrgId,
        domainRole: "RISK_OWNER",
        reason: "Testing separation of duties self-risk-owner refusal"
      }
    });
    assert.strictEqual(selfRiskOwnerId.status, 403, `Tenant Admin must be refused self-assigning RISK_OWNER by principalId (got ${selfRiskOwnerId.status})`);

    // 3. Self-inviting APPROVER -> 403
    const selfInviteApprover = await expressCall("POST", "/api/v2/tenant-admin/invitations", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `sod-self-inv-app-${suffix}` },
      body: {
        email: taAdminSub,
        organizationId: tenantARootOrgId,
        domainRole: "APPROVER",
        reason: "Testing self-invite APPROVER refusal"
      }
    });
    assert.strictEqual(selfInviteApprover.status, 403, `Tenant Admin must be refused self-inviting APPROVER (got ${selfInviteApprover.status})`);

    // 4. Self-assigning non-approval role (VIEWER) is permitted and explicitly tagged self_assigned:true in audit
    const selfViewer = await expressCall("POST", "/api/v2/tenant-admin/memberships", {
      token: tenantAEmployerAdminToken,
      headers: { "idempotency-key": `sod-self-viewer-${suffix}` },
      body: {
        principalId: taBoot.body.principalId,
        kind: "USER",
        organizationId: tenantARootOrgId,
        domainRole: "VIEWER",
        reason: "Audited self-assignment of non-approval role"
      }
    });
    assert.ok([200, 201].includes(selfViewer.status), `Non-approval self-assignment should succeed (got ${selfViewer.status}: ${selfViewer.raw})`);
    const sodAudit = await expressCall("GET", "/api/v2/tenant-admin/audit?command=tenant.membership.assign&limit=50", {
      token: tenantAEmployerAdminToken
    });
    assert.strictEqual(sodAudit.status, 200);
    assert.ok(
      (sodAudit.body.items || []).some((e: any) => Array.isArray(e.evidence_refs) && e.evidence_refs.includes("self_assigned:true")),
      "Self-assigned non-approval membership must record self_assigned:true in tenant audit_event"
    );

    // 5. Control owner cannot approve their own control outside local/test (requireSeparationOfDuties)
    assert.throws(
      () => requireSeparationOfDuties(taBoot.body.principalId, taBoot.body.principalId, "staging"),
      /Separation of duties/i,
      "Control owner must be refused approving their own control in staging/production"
    );
    assert.throws(
      () => requireSeparationOfDuties(taBoot.body.principalId, taBoot.body.principalId, "production"),
      /Separation of duties/i,
      "Control owner must be refused approving their own control in production"
    );
    // Distinct approver succeeds in staging/production
    requireSeparationOfDuties(taBoot.body.principalId, tbBoot.body.principalId, "production");
  });

  console.log(`\n\x1b[32m✔ Admin & Tenant-Admin Authorization Matrix Suite PASSED (${passed} checks).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[ADMIN MATRIX TEST FAILED]\x1b[0m", err);
  process.exit(1);
});
