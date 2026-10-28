// backend/src/fixtures/seed.ts
import { GOLDEN_01 } from "./golden01";
import { memDb, appPool } from "../platform/db/with-tenant";
import { assertNotProduction } from "../platform/config";

export async function seedTwoTenants(opts: { clock?: Date } = {}) {
  // Enforce mandatory playbook guard: refuses to run in staging or production
  assertNotProduction("seedTwoTenants");

  const clock = opts.clock || new Date();
  const validFrom = new Date(clock.getTime() - 90 * 24 * 3600 * 1000).toISOString(); // 90 days ago

  // 1. Seed Tenant A
  const tA = {
    id: GOLDEN_01.tenantA.id,
    name: GOLDEN_01.tenantA.name,
    region: GOLDEN_01.tenantA.region,
    jurisdiction_config_ref: "legal-uk-sra-v1",
    created_at: validFrom
  };
  memDb.tenants.set(tA.id, tA);

  const orgA = {
    id: "00000000-0000-4000-a001-000000000001",
    tenant_id: tA.id,
    parent_id: null,
    name: "Corporate Litigation Practice"
  };
  memDb.organizations.set(orgA.id, orgA);

  const principalA = {
    id: "00000000-0000-4000-a002-000000000001",
    tenant_id: tA.id,
    external_subject: "auth0|user-tenant-a-risk-owner",
    kind: "USER"
  };
  memDb.principals.set(principalA.id, principalA);

  const membershipA = {
    id: "00000000-0000-4000-a003-000000000001",
    tenant_id: tA.id,
    principal_id: principalA.id,
    organization_id: orgA.id,
    domain_role: "RISK_OWNER",
    valid_from: validFrom,
    valid_to: null,
    recorded_at: validFrom
  };
  memDb.memberships.set(membershipA.id, membershipA);

  // Seed Phase 2 Source Contract & Active Connection for Tenant A
  const contractA = {
    id: "00000000-0000-4000-a005-000000000001",
    tenant_id: tA.id,
    source: "ZoikoTime",
    version: "v1.0",
    contract_hash: "sha256-contract-zoikotime-v1.0-approved",
    status: "ACTIVE"
  };
  memDb.sourceContracts.set(contractA.id, contractA);

  const connA = {
    id: "00000000-0000-4000-a004-000000000001",
    tenant_id: tA.id,
    source: "ZoikoTime",
    contract_id: contractA.id,
    state: "ACTIVE",
    last_success_at: new Date(clock.getTime() - 15 * 60 * 1000).toISOString(), // 15 mins ago (FRESH)
    expected_cadence_seconds: 3600
  };
  memDb.connections.set(connA.id, connA);

  // 2. Seed Tenant B
  const tB = {
    id: GOLDEN_01.tenantB.id,
    name: GOLDEN_01.tenantB.name,
    region: GOLDEN_01.tenantB.region,
    jurisdiction_config_ref: "legal-uk-bar-v1",
    created_at: validFrom
  };
  memDb.tenants.set(tB.id, tB);

  const orgB = {
    id: "00000000-0000-4000-b001-000000000001",
    tenant_id: tB.id,
    parent_id: null,
    name: "Commercial Arbitration Chambers"
  };
  memDb.organizations.set(orgB.id, orgB);

  const principalB = {
    id: "00000000-0000-4000-b002-000000000001",
    tenant_id: tB.id,
    external_subject: "auth0|user-tenant-b-risk-owner",
    kind: "USER"
  };
  memDb.principals.set(principalB.id, principalB);

  const membershipB = {
    id: "00000000-0000-4000-b003-000000000001",
    tenant_id: tB.id,
    principal_id: principalB.id,
    organization_id: orgB.id,
    domain_role: "RISK_OWNER",
    valid_from: validFrom,
    valid_to: null,
    recorded_at: validFrom
  };
  memDb.memberships.set(membershipB.id, membershipB);

  // Seed Phase 2 Source Contract & Connection for Tenant B
  const contractB = {
    id: "00000000-0000-4000-b005-000000000001",
    tenant_id: tB.id,
    source: "ZoikoTime",
    version: "v1.0",
    contract_hash: "sha256-contract-zoikotime-v1.0-approved",
    status: "ACTIVE"
  };
  memDb.sourceContracts.set(contractB.id, contractB);

  const connB = {
    id: "00000000-0000-4000-b004-000000000001",
    tenant_id: tB.id,
    source: "ZoikoTime",
    contract_id: contractB.id,
    state: "ACTIVE",
    last_success_at: new Date(clock.getTime() - 4 * 3600 * 1000).toISOString(), // 4 hours ago (> 3x cadence -> STALE)
    expected_cadence_seconds: 3600
  };
  memDb.connections.set(connB.id, connB);

  return {
    tenantA: { tenant: tA, org: orgA, principal: principalA, membership: membershipA, connection: connA },
    tenantB: { tenant: tB, org: orgB, principal: principalB, membership: membershipB, connection: connB }
  };
}

