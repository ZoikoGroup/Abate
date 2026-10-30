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

  // Seed Phase 3 Baseline Privacy Release (for Hazard/Control anchoring)
  const baselineReleaseId = "00000000-0000-4000-a003-000000000001";
  const baselineRelease = {
    id: baselineReleaseId,
    tenant_id: tA.id,
    decision_id: "00000000-0000-4000-a003-000000000000",
    snapshot_id: "00000000-0000-4000-a003-000000000002",
    metric_id: "BOUNDARY_INTRUSION_SHARE",
    metric_version: 1,
    release_class: "CLASS_B",
    status: "RELEASED",
    superseded_by: null,
    released_at: validFrom
  };
  memDb.privacyReleases.set(baselineReleaseId, baselineRelease);
  memDb.privacyReleases.set("rel-baseline-1", { ...baselineRelease, id: "rel-baseline-1" });

  const baselineArtifact = {
    release_id: baselineReleaseId,
    tenant_id: tA.id,
    metric_id: "BOUNDARY_INTRUSION_SHARE",
    metric_version: 1,
    value: 23.4,
    unit: "percent",
    period_start: "2026-03-02T00:00:00.000Z",
    period_end: "2026-03-30T00:00:00.000Z",
    quality: "VALID",
    interpretation: "23.4% of recorded minutes occurred outside scheduled boundary windows.",
    status: "RELEASED",
    artifact_hash: "sha256-baseline-artifact-1"
  };
  memDb.releasedArtifacts.set(baselineReleaseId, baselineArtifact);
  memDb.releasedArtifacts.set("rel-baseline-1", { ...baselineArtifact, release_id: "rel-baseline-1" });


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

  // Seed Phase 5 Multi-Kind Policy Packs & Bindings (Playbook B5 §4)
  const policyPackSra = {
    pack_id: 'legal-uk-sra',
    version: 1,
    kind: 'JURISDICTION',
    title: 'UK SRA Workplace Standards',
    description: 'Solicitors Regulation Authority workplace risk and governance standard',
    publisher: 'SRA-Standards-Board',
    effective_from: validFrom,
    effective_to: null,
    definition: {
      permittedFeatures: ['*'],
      gates: { APPROVAL: ['RISK_OWNER'], REVIEW: ['WORKS_COUNCIL'] },
      privacyFloor: 10,
      aiAuthority: 'ADVISORY'
    },
    pack_hash: 'sha256-pack-legal-uk-sra-v1',
    status: 'APPROVED',
    approved_by: 'LEGAL_LEAD',
    approved_at: validFrom
  };
  memDb.policyPacks.set('legal-uk-sra:1', policyPackSra);

  const policyPackSector = {
    pack_id: 'sector-legal',
    version: 1,
    kind: 'SECTOR',
    title: 'Legal Professional Services Sector Standard',
    description: 'Demand windows, prohibited work product surveillance, and baseline privacy rules',
    publisher: 'Legal-Sector-Council',
    effective_from: validFrom,
    effective_to: null,
    definition: {
      permittedFeatures: ['*'],
      demandWindows: ['TRIAL_PREP', 'TRIAL', 'CLOSING', 'FILING_DEADLINE'],
      forbiddenWorkProduct: ['substantiveWorkProduct'],
      privacyFloor: 10
    },
    pack_hash: 'sha256-pack-sector-legal-v1',
    status: 'APPROVED',
    approved_by: 'LEGAL_LEAD',
    approved_at: validFrom
  };
  memDb.policyPacks.set('sector-legal:1', policyPackSector);

  const policyPackBar = {
    pack_id: 'legal-uk-bar',
    version: 1,
    kind: 'JURISDICTION',
    title: 'UK Bar Council Standards',
    description: 'Bar Standards Board governance policy',
    publisher: 'Bar-Council',
    effective_from: validFrom,
    effective_to: null,
    definition: {
      permittedFeatures: ['*'],
      gates: { APPROVAL: ['RISK_OWNER'] },
      privacyFloor: 10
    },
    pack_hash: 'sha256-pack-legal-uk-bar-v1',
    status: 'APPROVED',
    approved_by: 'LEGAL_LEAD',
    approved_at: validFrom
  };
  memDb.policyPacks.set('legal-uk-bar:1', policyPackBar);

  const policyPackExpired = {
    pack_id: 'jurisdiction-expired',
    version: 1,
    kind: 'JURISDICTION',
    title: 'Expired Jurisdiction Policy Pack',
    description: 'Demonstrates fail-closed compliance claims upon expiration',
    publisher: 'Deprecated-Authority',
    effective_from: '2020-01-01T00:00:00.000Z',
    effective_to: '2021-01-01T00:00:00.000Z',
    definition: { permittedFeatures: ['*'] },
    pack_hash: 'sha256-pack-expired-v1',
    status: 'APPROVED',
    approved_by: 'LEGAL_LEAD',
    approved_at: '2020-01-01T00:00:00.000Z'
  };
  memDb.policyPacks.set('jurisdiction-expired:1', policyPackExpired);

  // Bind Tenant A -> legal-uk-sra:1 & sector-legal:1
  memDb.tenantPolicyBindings.push(
    {
      id: '00000000-0000-4000-a006-000000000001',
      tenant_id: tA.id,
      pack_id: 'legal-uk-sra',
      pack_version: 1,
      bound_at: validFrom,
      bound_by: 'SYSTEM',
      status: 'ACTIVE'
    },
    {
      id: '00000000-0000-4000-a006-000000000002',
      tenant_id: tA.id,
      pack_id: 'sector-legal',
      pack_version: 1,
      bound_at: validFrom,
      bound_by: 'SYSTEM',
      status: 'ACTIVE'
    }
  );

  // Bind Tenant B -> legal-uk-bar:1 & sector-legal:1
  memDb.tenantPolicyBindings.push(
    {
      id: '00000000-0000-4000-b006-000000000001',
      tenant_id: tB.id,
      pack_id: 'legal-uk-bar',
      pack_version: 1,
      bound_at: validFrom,
      bound_by: 'SYSTEM',
      status: 'ACTIVE'
    },
    {
      id: '00000000-0000-4000-b006-000000000002',
      tenant_id: tB.id,
      pack_id: 'sector-legal',
      pack_version: 1,
      bound_at: validFrom,
      bound_by: 'SYSTEM',
      status: 'ACTIVE'
    }
  );


  // Seed Phase 6 Bounded AI Use Cases & Tool Catalog
  const explainUseCase = {
    key: "explain_release",
    version: 1,
    purpose: "Explain released cohort psychosocial hazard indicators and suggest organizational mitigations.",
    allowed_inputs: ["RELEASE", "KNOWLEDGE"],
    output_schema_ref: "schema:ai_proposal_v1",
    prompt_version: "explain_release_v1",
    model_ref: "zoiko-mock-v1",
    provider_region: "eu-west-2",
    max_steps: 1,
    max_input_tokens: 2048,
    max_output_tokens: 1024,
    timeout_ms: 8000,
    monthly_budget_minor: 100000,
    enabled: true,
    eval_thresholds: { usefulness: 0.9, groundedness: 1.0, numericFidelity: 1.0, safety: 1.0 }
  };
  memDb.aiUseCases.set("explain_release:1", explainUseCase);

  const causeUseCase = {
    key: "draft_cause",
    version: 1,
    purpose: "Propose organizational cause hypotheses from verified cohort hazard conditions.",
    allowed_inputs: ["RELEASE", "KNOWLEDGE"],
    output_schema_ref: "schema:ai_proposal_v1",
    prompt_version: "draft_cause_v1",
    model_ref: "zoiko-mock-v1",
    provider_region: "eu-west-2",
    max_steps: 1,
    max_input_tokens: 2048,
    max_output_tokens: 1024,
    timeout_ms: 8000,
    monthly_budget_minor: 100000,
    enabled: true,
    eval_thresholds: { usefulness: 0.9, groundedness: 1.0, numericFidelity: 1.0, safety: 1.0 }
  };
  memDb.aiUseCases.set("draft_cause:1", causeUseCase);

  const controlUseCase = {
    key: "draft_control",
    version: 1,
    purpose: "Draft control parameters and suggested verification criteria from the approved catalog.",
    allowed_inputs: ["RELEASE", "KNOWLEDGE"],
    output_schema_ref: "schema:ai_proposal_v1",
    prompt_version: "draft_control_v1",
    model_ref: "zoiko-mock-v1",
    provider_region: "eu-west-2",
    max_steps: 1,
    max_input_tokens: 2048,
    max_output_tokens: 1024,
    timeout_ms: 8000,
    monthly_budget_minor: 100000,
    enabled: true,
    eval_thresholds: { usefulness: 0.9, groundedness: 1.0, numericFidelity: 1.0, safety: 1.0 }
  };
  memDb.aiUseCases.set("draft_control:1", controlUseCase);

  // Seed Tool Catalog
  memDb.toolCatalog.set("ticket_notification", {
    tool: "ticket_notification",
    schema_ref: "schema:ticket_notification_v1",
    enabled: true
  });
  memDb.toolCatalog.set("calendar_window", {
    tool: "calendar_window",
    schema_ref: "schema:calendar_window_v1",
    enabled: true
  });

  return {
    tenantA: { tenant: tA, org: orgA, principal: principalA, membership: membershipA, connection: connA },
    tenantB: { tenant: tB, org: orgB, principal: principalB, membership: membershipB, connection: connB }
  };
}

