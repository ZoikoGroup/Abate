// backend/tools/test-phase7-planes.ts
// Phase 7 Two-Plane Separation Test Suite (Specification BE-009)
// Architecture Ref: ZAB-ENG-001 v1.0 / Package B7 (Domains S13 & S14) & ADR-007
//
// Verifies:
// 1. Performance outcome write cannot alter or close an open hazard (Plane B cannot mutate Plane A)
// 2. Prohibited causal claims in outcome evaluations are strictly rejected (VALIDATION)
// 3. Direct database writes to hazard disposition via Plane B fail closed (FORBIDDEN)
// 4. Cross-plane release endpoint isolation (Plane B releases hidden from Plane A reader endpoints)
// 5. AI Change Assessment staged workflow blocks closure while assurance obligations remain open

import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, authenticate, resolveActor } from "../src/domains/tenant/auth";
import { withTenant, memDb } from "../src/platform/db/with-tenant";
import { setFeatureFlag, evaluateOutcome } from "../src/domains/performance";
import { getRelease } from "../src/domains/privacy";
import {
  registerAiChangeProfile,
  createAssessment,
  advanceAssessment
} from "../src/domains/aichange";
import { AppError } from "../src/platform/errors";

console.log("\x1b[36m=== Abate Task Runner: test-phase7-planes (BE-009 Two-Plane Separation) ===\x1b[0m\n");

let passed = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      await res;
    }
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

const isCode = (code: string) => (err: any) => err?.code === code || (err instanceof AppError && err.code === code);

async function main() {
  // Step 0: Seed base multi-tenant environment
  await runTest("Setup: Seed isolated two-tenant environment", async () => {
    await seedTwoTenants();
  });

  const tenantAId = GOLDEN_01.tenantA.id;
  const tokenA = createDevToken({
    tenantId: tenantAId,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  });
  const whoA = await authenticate(`Bearer ${tokenA}`);
  const actorA = await resolveActor(whoA.tenantId, whoA.subject);

  // Test 1: Performance outcome write cannot close an open hazard (Plane B cannot mutate Plane A)
  await runTest("Test 1: Performance outcome write cannot mutate or close an open hazard", async () => {
    const p7ReleaseId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        `INSERT INTO privacy_release (id, tenant_id, decision_id, snapshot_id, metric_id, metric_version, release_class, status, plane)
         VALUES ($1, $2, $3, $4, 'BOUNDARY_INTRUSION_SHARE', 1, 'CLASS_B', 'RELEASED', 'A')`,
        [p7ReleaseId, tenantAId, crypto.randomUUID(), crypto.randomUUID()]
      );
      await tx.q(
        `INSERT INTO released_artifact (release_id, tenant_id, metric_id, metric_version, value, unit, period_start, period_end, quality, interpretation, status, artifact_hash, plane)
         VALUES ($1, $2, 'BOUNDARY_INTRUSION_SHARE', 1, 20.0, 'percent', now() - interval '28 days', now(), 'VALID', 'Intervention verification', 'RELEASED', 'hash-p7', 'A')`,
        [p7ReleaseId, tenantAId]
      );
    });

    const hazardId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        "INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'OPEN', 1)",
        [hazardId, tenantAId, "Night workload surge", actorA.principalId, p7ReleaseId]
      );
    });

    // Enable outcomes_plane_b feature flag
    await withTenant(tenantAId, async (tx) => {
      await setFeatureFlag(tx, "outcomes_plane_b", true, "ops.admin", tenantAId);
    });

    // Evaluate performance outcome in Plane B
    const evalResult = await withTenant(tenantAId, async (tx) => {
      return await evaluateOutcome(tx, actorA, {
        outcomeId: "WORKLOAD_SUSTAINABILITY",
        outcomeVersion: 1,
        releaseId: p7ReleaseId,
        comparisonBasis: { method: "PRE_POST_INTERVENTION", windowDays: 28, description: "4-week cohort observation interval" },
        confounders: {},
        seriesBreak: false,
        outcomeConfidence: "HIGH",
        permittedClaims: ["Observed 12% improvement in rest interval compliance."],
        evidenceRefs: []
      });
    }, { writePlane: "B" });

    assert.strictEqual(evalResult.plane, "B");

    // Invariant: Plane A hazard remains strictly OPEN
    const hRow = await withTenant(tenantAId, async (tx) => {
      return (await tx.q("SELECT disposition FROM hazard WHERE id = $1", [hazardId])).rows[0];
    });
    assert.strictEqual(hRow.disposition, "OPEN", "Plane B evaluation must NEVER mutate or close Plane A hazard disposition");
  });

  // Test 2: Prohibited causal claims in outcome evaluation are strictly rejected
  await runTest("Test 2: Prohibited claims in outcome evaluation are rejected (VALIDATION)", async () => {
    const claimRelId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        `INSERT INTO privacy_release (id, tenant_id, decision_id, snapshot_id, metric_id, metric_version, release_class, status, plane)
         VALUES ($1, $2, $3, $4, 'WORKLOAD_SUSTAINABILITY', 1, 'CLASS_B', 'RELEASED', 'A')`,
        [claimRelId, tenantAId, crypto.randomUUID(), crypto.randomUUID()]
      );
      await tx.q(
        `INSERT INTO released_artifact (release_id, tenant_id, metric_id, metric_version, value, unit, period_start, period_end, quality, interpretation, status, artifact_hash, plane)
         VALUES ($1, $2, 'WORKLOAD_SUSTAINABILITY', 1, 20.0, 'percent', now() - interval '28 days', now(), 'VALID', 'Claims test', 'RELEASED', 'hash-claim', 'A')`,
        [claimRelId, tenantAId]
      );
    });

    await withTenant(tenantAId, async (tx) => {
      await assert.rejects(async () => {
        await evaluateOutcome(tx, actorA, {
          outcomeId: "WORKLOAD_SUSTAINABILITY",
          outcomeVersion: 1,
          releaseId: claimRelId,
          comparisonBasis: { method: "COHORT_OBSERVATION", description: "Cohort observation" },
          confounders: {},
          seriesBreak: false,
          outcomeConfidence: "HIGH",
          permittedClaims: ["This evaluation proved the intervention worked and controlled the hazard."],
          evidenceRefs: []
        });
      }, isCode("VALIDATION"));
    }, { writePlane: "B" });
  });

  // Test 3: Direct database write to hazard disposition via Plane B context is forbidden
  await runTest("Test 3: Direct database write to hazard disposition via Plane B fails (FORBIDDEN)", async () => {
    await assert.rejects(async () => {
      await withTenant(tenantAId, async (tx) => {
        await tx.q("UPDATE hazard SET disposition = 'CONTROLLED'");
      }, { writePlane: "B" });
    }, isCode("FORBIDDEN"));
  });

  // Test 4: Cross-plane release endpoint isolation
  await runTest("Test 4: Cross-plane release endpoint isolation (Plane B hidden from Plane A reader)", async () => {
    const relBId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        `INSERT INTO privacy_release (id, tenant_id, decision_id, snapshot_id, metric_id, metric_version, release_class, status, plane)
         VALUES ($1, $2, $3, $4, 'WORKLOAD_SUSTAINABILITY', 1, 'CLASS_B', 'RELEASED', 'B')`,
        [relBId, tenantAId, crypto.randomUUID(), crypto.randomUUID()]
      );
      await tx.q(
        `INSERT INTO released_artifact (release_id, tenant_id, metric_id, metric_version, value, unit, period_start, period_end, quality, interpretation, status, artifact_hash, plane)
         VALUES ($1, $2, 'WORKLOAD_SUSTAINABILITY', 1, 88.5, 'score', now() - interval '28 days', now(), 'VALID', 'Workload sustainability score', 'RELEASED', 'hash-rel-b', 'B')`,
        [relBId, tenantAId]
      );
    }, { writePlane: "B" });

    // Plane A reader rejects Plane B release with NOT_FOUND
    await assert.rejects(async () => {
      await getRelease(actorA, relBId, "A");
    }, isCode("NOT_FOUND"));

    // Plane B reader successfully reads Plane B release
    const relB = await getRelease(actorA, relBId, "B");
    assert.strictEqual(relB.plane, "B");
    assert.strictEqual(relB.status, "RELEASED");
  });

  // Test 5: AI Change assessment workflow blocks closure while hazard obligations remain open
  await runTest("Test 5: AI Change assessment blocks closure while hazard obligations remain open (CONFLICT)", async () => {
    const aiBaselineReleaseId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        `INSERT INTO privacy_release (id, tenant_id, decision_id, snapshot_id, metric_id, metric_version, release_class, status, plane)
         VALUES ($1, $2, $3, $4, 'BOUNDARY_INTRUSION_SHARE', 1, 'CLASS_B', 'RELEASED', 'A')`,
        [aiBaselineReleaseId, tenantAId, crypto.randomUUID(), crypto.randomUUID()]
      );
      await tx.q(
        `INSERT INTO released_artifact (release_id, tenant_id, metric_id, metric_version, value, unit, period_start, period_end, quality, interpretation, status, artifact_hash, plane)
         VALUES ($1, $2, 'BOUNDARY_INTRUSION_SHARE', 1, 18.5, 'percent', now() - interval '28 days', now(), 'VALID', 'Baseline for AI rollout', 'RELEASED', 'hash-ai-base', 'A')`,
        [aiBaselineReleaseId, tenantAId]
      );
    });

    // 1. Register AI Change Profile
    const profile = await withTenant(tenantAId, async (tx) => {
      return await registerAiChangeProfile(tx, actorA, {
        title: "Copilot Assistant Rollout",
        affectedRoles: ["Associate"],
        affectedTasks: ["Litigation brief first-draft synthesis"],
        automationMode: "ASSIST",
        decisionRights: "Supervising partner retains sign-off on every brief",
        humanOverride: "Associates may discard or rewrite any generated draft",
        monitoringChanges: "No new individual monitoring; cohort-level review only",
        throughputAssumptions: "Decreases drafting time while preserving role clarity",
        rolloutDate: "2026-06-01",
        trainingSupport: "Two-hour onboarding on review and override"
      });
    });
    assert.strictEqual(profile.version, 1);

    // 2. Create Assessment (starts in REGISTERED)
    const assessment = await withTenant(tenantAId, async (tx) => {
      return await createAssessment(tx, actorA, {
        profileId: profile.id,
        profileVersion: 1
      });
    });
    assert.strictEqual(assessment.stage, "REGISTERED");

    // 3. Advance without matching version fails with CONFLICT
    await assert.rejects(async () => {
      await withTenant(tenantAId, async (tx) => {
        await advanceAssessment(tx, actorA, assessment.id, "BASELINE", 999);
      });
    }, isCode("CONFLICT"));

    // 4. Advance to BASELINE
    const atBaseline = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "BASELINE", 1);
    });
    assert.strictEqual(atBaseline.stage, "BASELINE");

    // 5. Advance to DETECT with valid baseline release
    const atDetect = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "DETECT", atBaseline.version, {
        baselineReleaseIds: [aiBaselineReleaseId]
      });
    });
    assert.strictEqual(atDetect.stage, "DETECT");

    // 6. Advance to ATTRIBUTE with candidate hazard and accepted organizational cause
    const testHazardId = crypto.randomUUID();
    const testCauseId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        "INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'OPEN', 1)",
        [testHazardId, tenantAId, "Cognitive pacing disruption", actorA.principalId, aiBaselineReleaseId]
      );
      await tx.q(
        "INSERT INTO cause (id, tenant_id, hazard_id, statement, status, reviewed_by, reviewed_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [testCauseId, tenantAId, testHazardId, "Pacing overload due to unconstrained automated generation", "REVIEWED_ACCEPTED", actorA.principalId, new Date().toISOString(), 1]
      );
    });

    const atAttribute = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "ATTRIBUTE", atDetect.version, {
        hazardIds: [testHazardId]
      });
    });
    assert.strictEqual(atAttribute.stage, "ATTRIBUTE");

    // 7. Advance to CONTROL with implemented intervention
    const testInterventionId = crypto.randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.q(
        "INSERT INTO intervention (id, tenant_id, hazard_id, scope, objective, target_date, state, version) VALUES ($1, $2, $3, 'Scope', 'Objective', '2026-06-01', 'IMPLEMENTED', 1)",
        [testInterventionId, tenantAId, testHazardId]
      );
    });

    const atControl = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "CONTROL", atAttribute.version, {
        controlIds: [testInterventionId]
      });
    });
    assert.strictEqual(atControl.stage, "CONTROL");

    // 8. Advance to VERIFY
    const atVerify = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "VERIFY", atControl.version, {
        verificationRefs: ["evidence:pacing-audit-v1"]
      });
    });
    assert.strictEqual(atVerify.stage, "VERIFY");

    // 9. Advance to PERFORMANCE_REVIEW
    const atReview = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "PERFORMANCE_REVIEW", atVerify.version);
    });
    assert.strictEqual(atReview.stage, "PERFORMANCE_REVIEW");

    // 10. Attempt to CLOSE assessment while hazard is OPEN is REFUSED!
    await assert.rejects(async () => {
      await withTenant(tenantAId, async (tx) => {
        await advanceAssessment(tx, actorA, assessment.id, "CLOSED", atReview.version);
      });
    }, isCode("CONFLICT"), "Assessment closure MUST be rejected while any assurance obligation remains open");

    // 11. Close assurance obligations in Plane A
    await withTenant(tenantAId, async (tx) => {
      await tx.q("UPDATE hazard SET disposition = 'CONTROLLED' WHERE id = $1", [testHazardId]);
      await tx.q("UPDATE intervention SET state = 'CLOSED' WHERE id = $1", [testInterventionId]);
    }, { writePlane: "A" });

    // 12. Advancing to CLOSED now succeeds!
    const closed = await withTenant(tenantAId, async (tx) => {
      return await advanceAssessment(tx, actorA, assessment.id, "CLOSED", atReview.version);
    });
    assert.strictEqual(closed.stage, "CLOSED");
  });

  console.log(`\n\x1b[32m✔ Completed Phase 7 Two-Plane Separation Test Suite: ${passed}/5 tests passed.\x1b[0m\n`);
}

main().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

