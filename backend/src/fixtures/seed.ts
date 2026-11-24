// backend/src/fixtures/seed.ts
import { GOLDEN_01 } from "./golden01";
import { memDb } from "../platform/db/with-tenant";
import { assertNotProduction } from "../platform/config";
import crypto from "node:crypto";
import { Pool } from "pg";
import { packContentHash } from "../domains/lifecycle/jurisdiction";
import { materialHash } from "../domains/control/material";
import { PROTOTYPE_OUTCOME_DEFINITIONS, calculateDefinitionHash } from "../domains/performance/definitions";

export interface SeedTwoTenantsOptions {
  clock?: Date;
  persistToPostgres?: boolean;
}

export async function seedTwoTenants(opts: SeedTwoTenantsOptions = {}) {
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

  const principalsA: any[] = [principalA];
  const membershipsA: any[] = [membershipA];

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
    principalsA.push(p);

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
    membershipsA.push(m);
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

  const contractCalA = {
    id: "00000000-0000-4000-a005-000000000002",
    tenant_id: tA.id,
    source: "CalendarCadence",
    version: "v1.0",
    contract_hash: "sha256-contract-calendar-cadence-v1.0-approved",
    status: "ACTIVE"
  };
  memDb.sourceContracts.set(contractCalA.id, contractCalA);

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
  const principalsB: any[] = [];
  const membershipsB: any[] = [];

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
    principalsB.push(p);
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
    membershipsB.push(m);
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
      allowedDimensions: ["unit", "team"],
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
    plane: "A",
    artifact_hash: "sha256-baseline-artifact-1"
  };
  memDb.releasedArtifacts.set(baselineReleaseId, baselineArtifact);


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

  const contractCalB = {
    id: "00000000-0000-4000-b005-000000000002",
    tenant_id: tB.id,
    source: "CalendarCadence",
    version: "v1.0",
    contract_hash: "sha256-contract-calendar-cadence-v1.0-approved",
    status: "ACTIVE"
  };
  memDb.sourceContracts.set(contractCalB.id, contractCalB);

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

  // Seed Phase 5 Multi-Kind Policy Packs & Bindings (Playbook B5 §4).
  // Rows use the 0051_governance_evidence.sql columns so the resolver reads the same shape as PostgreSQL.
  const policyPack = (
    key: string,
    kind: "JURISDICTION" | "SECTOR" | "CUSTOMER",
    effectiveFrom: string,
    effectiveTo: string | null,
    content: Record<string, unknown>
  ) => ({
    id: crypto.randomUUID(),
    pack_key: key,
    version: 1,
    kind,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    status: "APPROVED",
    source_refs: [content.publisher],
    accountable_reviewer: "LEGAL_LEAD",
    review_date: "2027-01-01",
    content,
    content_hash: packContentHash(content)
  });

  const seededPolicyPacks = [
    policyPack("legal-uk-sra", "JURISDICTION", validFrom, null, {
      title: "UK SRA Workplace Standards",
      description: "Solicitors Regulation Authority workplace risk and governance standard",
      publisher: "SRA-Standards-Board",
      permittedFeatures: ["*"],
      gates: { APPROVAL: ["RISK_OWNER"], REVIEW: ["WORKS_COUNCIL"] },
      privacyFloor: 10,
      aiAuthority: "ADVISORY",
      // SYNTHETIC: test durations and citations, not legal content (real values come from the Legal & Policy Lead)
      retention: {
        WORK_FACT: {
          floor: { days: 90, citation: "SYNTHETIC-FIXTURE floor" },
          ceiling: { days: 730, citation: "SYNTHETIC-FIXTURE ceiling" }
        }
      }
    }),
    policyPack("sector-legal", "SECTOR", validFrom, null, {
      title: "Legal Professional Services Sector Standard",
      description: "Demand windows, prohibited work product surveillance, and baseline privacy rules",
      publisher: "Legal-Sector-Council",
      permittedFeatures: ["*"],
      demandWindows: ["TRIAL_PREP", "TRIAL", "CLOSING", "FILING_DEADLINE"],
      forbiddenWorkProduct: ["substantiveWorkProduct"],
      privacyFloor: 10
    }),
    policyPack("legal-uk-bar", "JURISDICTION", validFrom, null, {
      title: "UK Bar Council Standards",
      description: "Bar Standards Board governance policy",
      publisher: "Bar-Council",
      permittedFeatures: ["*"],
      gates: { APPROVAL: ["RISK_OWNER"] },
      privacyFloor: 10
    }),
    policyPack("jurisdiction-expired", "JURISDICTION", "2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z", {
      title: "Expired Jurisdiction Policy Pack",
      description: "Demonstrates fail-closed compliance claims upon expiration",
      publisher: "Deprecated-Authority",
      permittedFeatures: ["*"]
    })
  ];
  for (const pack of seededPolicyPacks) {
    memDb.policyPacks.set(`${pack.pack_key}:${pack.version}`, pack);
  }

  // Tenant A -> legal-uk-sra + sector-legal; Tenant B -> legal-uk-bar + sector-legal
  const binding = (tenantId: string, packKey: string) => ({
    tenant_id: tenantId,
    pack_key: packKey,
    pack_version: 1,
    applies_to: {},
    bound_from: validFrom,
    bound_to: null
  });
  const seededBindings = [
    binding(tA.id, "legal-uk-sra"),
    binding(tA.id, "sector-legal"),
    binding(tB.id, "legal-uk-bar"),
    binding(tB.id, "sector-legal")
  ];
  for (const sb of seededBindings) {
    const existingIdx = memDb.tenantPolicyBindings.findIndex(
      (b: any) => b.tenant_id === sb.tenant_id && b.pack_key === sb.pack_key
    );
    if (existingIdx >= 0) {
      memDb.tenantPolicyBindings[existingIdx] = sb;
    } else {
      memDb.tenantPolicyBindings.push(sb);
    }
  }

  // Seed an approved control chain for Tenant A (hazard -> accepted cause -> APPROVED control -> approval),
  // so external actions have a real Phase 4 approval to bind to.
  const ac = GOLDEN_01.approvedControl;
  memDb.hazards.set(ac.hazardId, {
    id: ac.hazardId,
    tenant_id: tA.id,
    title: "After-hours client contact intrusion (seeded)",
    owner_principal_id: principalA.id,
    originating_release_id: baselineReleaseId,
    disposition: "OPEN",
    version: 1,
    created_at: validFrom
  });
  memDb.causes.set(ac.causeId, {
    id: ac.causeId,
    tenant_id: tA.id,
    hazard_id: ac.hazardId,
    statement: "Client matters are routed to individuals outside working hours with no rota.",
    status: "REVIEWED_ACCEPTED",
    reviewed_by: principalA.id,
    reviewed_at: validFrom,
    version: 1,
    created_at: validFrom
  });
  const controlDraft = {
    hazardId: ac.hazardId,
    causeId: ac.causeId,
    scope: "Corporate Litigation Practice",
    objective: "Route after-hours client contact through a staffed rota",
    ownerPrincipalId: principalA.id,
    dueDate: "2026-12-31",
    verificationPlan: { baselineReleaseId, primaryMetric: "BOUNDARY_INTRUSION_SHARE", minDays: 28 }
  };
  const controlHash = materialHash(controlDraft);
  memDb.interventions.set(ac.interventionId, {
    id: ac.interventionId,
    tenant_id: tA.id,
    hazard_id: ac.hazardId,
    cause_id: ac.causeId,
    state: "APPROVED",
    version: 1,
    scope: controlDraft.scope,
    objective: controlDraft.objective,
    owner_principal_id: principalA.id,
    due_date: controlDraft.dueDate,
    verification_plan: controlDraft.verificationPlan,
    material_hash: controlHash,
    created_at: validFrom
  });
  memDb.approvals.set(ac.approvalId, {
    id: ac.approvalId,
    tenant_id: tA.id,
    intervention_id: ac.interventionId,
    approved_version: 1,
    approved_material_hash: controlHash,
    approver_principal_id: principalA.id,
    authority_ref: "auth:playbook-b4",
    policy_resolution: { gate: "APPROVAL", resolved: true },
    expires_at: null,
    revoked_at: null,
    approved_at: validFrom
  });

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

  // Seed Phase 8 Independent Kill Switches (Playbook §8.4 / Page 91-92)
  const defaultKillSwitches = [
    { scope: "connector:zoikotime", active: false, changed_by: "system.init", changed_at: validFrom },
    { scope: "connector:calendar_cadence", active: false, changed_by: "system.init", changed_at: validFrom },
    { scope: "release_path", active: false, changed_by: "system.init", changed_at: validFrom },
    { scope: "pack:legal-uk-sra", active: false, changed_by: "system.init", changed_at: validFrom },
    { scope: "all_ai", active: false, changed_by: "system.init", changed_at: validFrom },
    { scope: "tool:ticket_notification", active: false, changed_by: "system.init", changed_at: validFrom }
  ];
  for (const ks of defaultKillSwitches) {
    if (!memDb.aiKillSwitches.has(ks.scope)) {
      memDb.aiKillSwitches.set(ks.scope, ks);
    }
  }

  if (opts.persistToPostgres || process.env.ABATE_SEED_PG === "1") {
    const connectionString = process.env.DATABASE_URL_MIGRATOR || process.env.DATABASE_URL_APP;
    if (!connectionString) {
      throw new Error("PostgreSQL seeding requested but DATABASE_URL_MIGRATOR / DATABASE_URL_APP is not configured.");
    }

    const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000 });
    try {
      const client = await pool.connect();
      try {
        const tenantBundles = [
          { tenant: tA, org: orgA, principals: principalsA, memberships: membershipsA, contracts: [contractA, contractCalA], connection: connA },
          { tenant: tB, org: orgB, principals: principalsB, memberships: membershipsB, contracts: [contractB, contractCalB], connection: connB }
        ];

        for (const b of tenantBundles) {
          await client.query("BEGIN");
          try {
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [b.tenant.id]);
            await client.query(
              `INSERT INTO tenant (id, name, region, jurisdiction_config_ref, created_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO NOTHING`,
              [b.tenant.id, b.tenant.name, b.tenant.region, b.tenant.jurisdiction_config_ref, b.tenant.created_at]
            );
            await client.query(
              `INSERT INTO organization (id, tenant_id, parent_id, name)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO NOTHING`,
              [b.org.id, b.org.tenant_id, b.org.parent_id, b.org.name]
            );
            for (const p of b.principals) {
              await client.query(
                `INSERT INTO principal (id, tenant_id, external_subject, kind)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO NOTHING`,
                [p.id, p.tenant_id, p.external_subject, p.kind]
              );
            }
            for (const m of b.memberships) {
              await client.query(
                `INSERT INTO effective_membership (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, recorded_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO NOTHING`,
                [
                  m.id,
                  m.tenant_id,
                  m.principal_id,
                  m.organization_id,
                  m.domain_role,
                  m.valid_from,
                  m.valid_to,
                  m.recorded_at
                ]
              );
            }
            for (const c of b.contracts) {
              await client.query(
                `INSERT INTO source_contract (id, tenant_id, source, version, contract_hash, status)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO NOTHING`,
                [c.id, c.tenant_id, c.source, c.version, c.contract_hash, c.status]
              );
            }
            await client.query(
              `INSERT INTO connection (id, tenant_id, source, contract_id, state, last_success_at, expected_cadence_seconds)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO NOTHING`,
              [
                b.connection.id,
                b.connection.tenant_id,
                b.connection.source,
                b.connection.contract_id,
                b.connection.state,
                b.connection.last_success_at,
                b.connection.expected_cadence_seconds
              ]
            );
            await client.query("COMMIT");
          } catch (txErr) {
            await client.query("ROLLBACK");
            throw txErr;
          }
        }

        // Phase 3/4 chain for Tenant A. The in-memory seed has it, so Postgres must too: without it the hazard,
        // evidence-package and control flows see an empty tenant and diverge from the in-memory behaviour.
        // Insert order follows the foreign keys: snapshot + decision -> release -> artifact -> hazard -> cause -> control -> approval.
        const br = baselineRelease;
        const ba = baselineArtifact;
        await client.query("BEGIN");
        try {
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [tA.id]);
          await client.query(
            `INSERT INTO metric_snapshot (id, tenant_id, metric_id, metric_version, cohort_ref, period_start, period_end,
               source_cutoff, code_digest, membership_version, value, quality, contributor_count, lineage, computed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
             ON CONFLICT (id) DO NOTHING`,
            [br.snapshot_id, tA.id, br.metric_id, br.metric_version, "cohort:seed-baseline", ba.period_start, ba.period_end,
            ba.period_end, "seed-baseline", "seed-v1", ba.value, ba.quality, GOLDEN_01.tenantA.cohortSize ?? 16,
            JSON.stringify({ seeded: true }), validFrom]
          );
          await client.query(
            `INSERT INTO privacy_decision (id, tenant_id, semantic_query_hash, outcome, reason_code, policy_version, decided_at)
             VALUES ($1, $2, $3, 'RELEASED', 'SEED_BASELINE', 'seed-v1', $4)
             ON CONFLICT (id) DO NOTHING`,
            [br.decision_id, tA.id, "seed-baseline-query", validFrom]
          );
          await client.query(
            `INSERT INTO privacy_release (id, tenant_id, decision_id, snapshot_id, metric_id, metric_version, release_class, status, superseded_by, released_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, superseded_by = EXCLUDED.superseded_by`,
            [br.id, tA.id, br.decision_id, br.snapshot_id, br.metric_id, br.metric_version, br.release_class, br.status, br.superseded_by, br.released_at]
          );
          await client.query(
            `INSERT INTO released_artifact (release_id, tenant_id, metric_id, metric_version, value, unit, period_start, period_end,
               quality, interpretation, status, artifact_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (release_id) DO NOTHING`,
            [ba.release_id, tA.id, ba.metric_id, ba.metric_version, ba.value, ba.unit, ba.period_start, ba.period_end,
            ba.quality, ba.interpretation, ba.status, ba.artifact_hash]
          );
          await client.query(
            `INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version, created_at)
             VALUES ($1, $2, $3, $4, $5, 'OPEN', 1, $6)
             ON CONFLICT (id) DO NOTHING`,
            [ac.hazardId, tA.id, "After-hours client contact intrusion (seeded)", principalA.id, baselineReleaseId, validFrom]
          );
          await client.query(
            `INSERT INTO cause (id, tenant_id, hazard_id, statement, status, reviewed_by, reviewed_at, version, created_at)
             VALUES ($1, $2, $3, $4, 'REVIEWED_ACCEPTED', $5, $6, 1, $6)
             ON CONFLICT (id) DO NOTHING`,
            [ac.causeId, tA.id, ac.hazardId, "Client matters are routed to individuals outside working hours with no rota.", principalA.id, validFrom]
          );
          await client.query(
            `INSERT INTO intervention (id, tenant_id, hazard_id, cause_id, state, version, scope, objective, owner_principal_id,
               due_date, verification_plan, material_hash, created_at)
             VALUES ($1, $2, $3, $4, 'APPROVED', 1, $5, $6, $7, $8, $9::jsonb, $10, $11)
             ON CONFLICT (id) DO NOTHING`,
            [ac.interventionId, tA.id, ac.hazardId, ac.causeId, controlDraft.scope, controlDraft.objective, principalA.id,
            controlDraft.dueDate, JSON.stringify(controlDraft.verificationPlan), controlHash, validFrom]
          );
          await client.query(
            `INSERT INTO approval (id, tenant_id, intervention_id, approved_version, approved_material_hash, approver_principal_id,
               authority_ref, policy_resolution, expires_at, revoked_at, approved_at)
             VALUES ($1, $2, $3, 1, $4, $5, 'auth:playbook-b4', $6::jsonb, NULL, NULL, $7)
             ON CONFLICT (id) DO NOTHING`,
            [ac.approvalId, tA.id, ac.interventionId, controlHash, principalA.id, JSON.stringify({ gate: "APPROVAL", resolved: true }), validFrom]
          );
          await client.query("COMMIT");
        } catch (chainErr) {
          await client.query("ROLLBACK");
          throw chainErr;
        }

        // Phase 5 jurisdiction/sector policy packs and the per-tenant bindings. Without them coverage reads NOT_COVERED
        // and retention/AI authority resolve differently from the in-memory seed.
        await client.query("BEGIN");
        try {
          for (const pack of seededPolicyPacks) {
            await client.query(
              `INSERT INTO policy_pack (id, pack_key, version, kind, effective_from, effective_to, status, source_refs,
                 accountable_reviewer, review_date, content, content_hash)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12)
               ON CONFLICT (pack_key, version) DO UPDATE SET
                 effective_from = LEAST(policy_pack.effective_from, EXCLUDED.effective_from),
                 effective_to = EXCLUDED.effective_to,
                 status = EXCLUDED.status,
                 content = EXCLUDED.content,
                 content_hash = EXCLUDED.content_hash`,
              [pack.id, pack.pack_key, pack.version, pack.kind, pack.effective_from, pack.effective_to, pack.status,
              JSON.stringify(pack.source_refs), pack.accountable_reviewer, pack.review_date,
              JSON.stringify(pack.content), pack.content_hash]
            );
          }
          for (const b of seededBindings) {
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [b.tenant_id]);
            await client.query(
              `DELETE FROM tenant_policy_binding WHERE tenant_id = $1 AND pack_key = $2`,
              [b.tenant_id, b.pack_key]
            );
            await client.query(
              `INSERT INTO tenant_policy_binding (tenant_id, pack_key, pack_version, applies_to, bound_from, bound_to)
               VALUES ($1, $2, $3, $4::jsonb, $5, $6)
               ON CONFLICT (tenant_id, pack_key, bound_from) DO NOTHING`,
              [b.tenant_id, b.pack_key, b.pack_version, JSON.stringify(b.applies_to), b.bound_from, b.bound_to]
            );
          }
          await client.query("COMMIT");
        } catch (packErr) {
          await client.query("ROLLBACK");
          throw packErr;
        }

        for (const ks of defaultKillSwitches) {
          await client.query(
            `INSERT INTO ai_kill_switch (scope, active, changed_by, changed_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (scope) DO NOTHING`,
            [ks.scope, ks.active, ks.changed_by, ks.changed_at]
          );
        }

        // Phase 6 Bounded AI use cases & Safe Action tool catalog (parity with memDb)
        await client.query("BEGIN");
        try {
          for (const uc of [explainUseCase, causeUseCase, controlUseCase]) {
            await client.query(
              `INSERT INTO ai_use_case (
                 key, version, purpose, allowed_inputs, output_schema_ref,
                 prompt_version, model_ref, provider_region, max_steps,
                 max_input_tokens, max_output_tokens, timeout_ms,
                 monthly_budget_minor, enabled, eval_thresholds
               ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
               ON CONFLICT (key, version) DO UPDATE SET
                 monthly_budget_minor = EXCLUDED.monthly_budget_minor,
                 enabled = EXCLUDED.enabled,
                 eval_thresholds = EXCLUDED.eval_thresholds`,
              [
                uc.key,
                uc.version,
                uc.purpose,
                JSON.stringify(uc.allowed_inputs),
                uc.output_schema_ref,
                uc.prompt_version,
                uc.model_ref,
                uc.provider_region,
                uc.max_steps,
                uc.max_input_tokens,
                uc.max_output_tokens,
                uc.timeout_ms,
                uc.monthly_budget_minor,
                uc.enabled,
                JSON.stringify(uc.eval_thresholds)
              ]
            );
          }
          for (const tc of memDb.toolCatalog.values()) {
            await client.query(
              `INSERT INTO tool_catalog (tool, schema_ref, enabled)
               VALUES ($1, $2, $3)
               ON CONFLICT (tool) DO UPDATE SET
                 schema_ref = EXCLUDED.schema_ref,
                 enabled = EXCLUDED.enabled`,
              [tc.tool, tc.schema_ref, tc.enabled]
            );
          }
          await client.query("COMMIT");
        } catch (aiSeedErr) {
          await client.query("ROLLBACK");
          throw aiSeedErr;
        }

        // Global approved metric and prototype outcome definitions (Plane A & Plane B parity with memDb)
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO metric_definition (metric_id, version, tenant_id, definition, definition_hash, status, approved_by, approved_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
             ON CONFLICT (metric_id, version) DO NOTHING`,
            [
              metricDef.metric_id,
              metricDef.version,
              metricDef.tenant_id,
              JSON.stringify(metricDef.definition),
              metricDef.definition_hash,
              metricDef.status,
              metricDef.approved_by,
              metricDef.approved_at
            ]
          );
          for (const od of PROTOTYPE_OUTCOME_DEFINITIONS) {
            await client.query(
              `INSERT INTO outcome_definition (
                outcome_id, version, outcome_class, family, purpose,
                prohibited_interpretation, unit, definition, quality_rules,
                privacy_class, status, definition_hash
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, 'APPROVED', $11)
              ON CONFLICT (outcome_id, version) DO NOTHING`,
              [
                od.outcomeId,
                od.version,
                od.outcomeClass,
                od.family,
                od.purpose,
                od.prohibitedInterpretation,
                od.unit,
                JSON.stringify(od.definition),
                JSON.stringify(od.qualityRules),
                od.privacyClass,
                calculateDefinitionHash(od.definition)
              ]
            );
          }
          await client.query("COMMIT");
        } catch (defErr) {
          await client.query("ROLLBACK");
          throw defErr;
        }
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  return {
    tenantA: { tenant: tA, org: orgA, principal: principalA, membership: membershipA, connection: connA },
    tenantB: { tenant: tB, org: orgB, principal: principalB, membership: membershipB, connection: connB }
  };
}

