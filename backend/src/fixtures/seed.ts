// backend/src/fixtures/seed.ts
import { GOLDEN_01 } from "./golden01";
import { memDb, appPool } from "../platform/db/with-tenant";
import { assertNotProduction } from "../platform/config";
import { packContentHash } from "../domains/lifecycle/jurisdiction";

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
    jurisdiction_config_ref: "legal-uk-sra",
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

  // Seed 15 additional synthetic cohort members for Tenant A (ABATE-GOLDEN-01 cohortSize: 16 total)
  for (let i = 2; i <= 16; i++) {
    const pad = i.toString().padStart(3, "0");
    const pId = `00000000-0000-4000-a002-000000000${pad}`;
    const p = {
      id: pId,
      tenant_id: tA.id,
      external_subject: `auth0|user-tenant-a-member-${pad}`,
      kind: "USER"
    };
    memDb.principals.set(p.id, p);

    const m = {
      id: `00000000-0000-4000-a003-000000000${pad}`,
      tenant_id: tA.id,
      principal_id: p.id,
      organization_id: orgA.id,
      domain_role: "MEMBER",
      valid_from: validFrom,
      valid_to: null,
      recorded_at: validFrom
    };
    memDb.memberships.set(m.id, m);
  }

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
    jurisdiction_config_ref: "legal-uk-bar",
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

  let principalB: any = null;
  let membershipB: any = null;

  // Seed 12 synthetic cohort members for Tenant B (ABATE-GOLDEN-01 cohortSize: 12)
  for (let i = 1; i <= 12; i++) {
    const pad = i.toString().padStart(3, "0");
    const pId = `00000000-0000-4000-b002-000000000${pad}`;
    const p = {
      id: pId,
      tenant_id: tB.id,
      external_subject: i === 1 ? "auth0|user-tenant-b-risk-owner" : `auth0|user-tenant-b-member-${pad}`,
      kind: "USER"
    };
    memDb.principals.set(p.id, p);
    if (i === 1) principalB = p;

    const m = {
      id: `00000000-0000-4000-b003-000000000${pad}`,
      tenant_id: tB.id,
      principal_id: p.id,
      organization_id: orgB.id,
      domain_role: i === 1 ? "RISK_OWNER" : "MEMBER",
      valid_from: validFrom,
      valid_to: null,
      recorded_at: validFrom
    };
    memDb.memberships.set(m.id, m);
    if (i === 1) membershipB = m;
  }

  // Seed Phase 3 Approved Metric Definition (BOUNDARY_INTRUSION_SHARE / 1)
  const metricDef = {
    id: "BOUNDARY_INTRUSION_SHARE",
    metric_id: "BOUNDARY_INTRUSION_SHARE",
    name: "Boundary Intrusion Share",
    hazard_domain: "Working Time Quality & Rest Deficits",
    version: 1,
    tenant_id: null, // global definition
    formula_id: "boundaryIntrusionShare",
    contributor_floor: 10,
    min_window_days: 28,
    definition: {
      purpose: "Cohort work-pattern condition. NOT an individual risk score, NOT a legal threshold.",
      formula: "outside_schedule_minutes / total_work_minutes; percent; 1 decimal",
      allowedDimensions: ["practice_area", "team"],
      qualityFloor: 0.8,
      releaseClass: "CLASS_B",
      contributorFloor: 10
    },
    definition_hash: "sha256-def-boundary-intrusion-share-v1",
    status: "APPROVED",
    approved_by: "00000000-0000-4000-a002-000000000001",
    approved_at: validFrom
  };
  memDb.metricDefinitions.set(`${metricDef.metric_id}:${metricDef.version}`, metricDef);

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

  // Seed Phase 5 jurisdiction pack for Tenant A only. SYNTHETIC: the durations and citations below are
  // test values, not legal content; real packs come from the Legal & Policy Lead. Tenant B's pack
  // ("legal-uk-bar") is deliberately unpublished so its retention configuration fails closed.
  const packContent = {
    title: "SYNTHETIC TEST PACK - UK legal sector (not legal advice)",
    sourceRefs: ["SYNTHETIC-FIXTURE: replace with Legal & Policy Lead citations"],
    retention: {
      WORK_FACT: {
        floor: { days: 90, citation: "SYNTHETIC-FIXTURE floor" },
        ceiling: { days: 730, citation: "SYNTHETIC-FIXTURE ceiling" }
      }
    }
  };
  const packA = {
    pack_id: tA.jurisdiction_config_ref,
    version: 1,
    jurisdiction: "UK",
    sector: "LEGAL",
    effective_from: validFrom,
    effective_to: null,
    status: "APPROVED",
    content: packContent,
    content_hash: packContentHash(packContent),
    approved_by: "SYNTHETIC-FIXTURE",
    approved_at: validFrom
  };
  memDb.jurisdictionPacks.set(`${packA.pack_id}:${packA.version}`, packA);

  return {
    tenantA: { tenant: tA, org: orgA, principal: principalA, membership: membershipA, connection: connA },
    tenantB: { tenant: tB, org: orgB, principal: principalB, membership: membershipB, connection: connB }
  };
}

