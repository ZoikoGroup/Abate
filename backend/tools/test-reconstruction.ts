// backend/tools/test-reconstruction.ts
// Phase 3 Reconstruction Attack Lab (Domain S06 Privacy Compiler)
// Architecture Ref: ZAB-ENG-001 v1.0 / Package B3 & ADR-003
//
// Proves mathematical defense against individual re-identification and differencing attacks:
// 1. Contributor Floor Gate (n < 10 suppressed as UNAVAILABLE; n >= 10 released)
// 2. Parent/Child Cohort Subtraction Attack (residual difference < 5 suppressed)
// 3. Overlapping Cohorts Differencing Attack (symmetric difference < 5 suppressed)
// 4. Advisory Lock Serialization (concurrent racing requests serialized)
// 5. Released Artifact Schema Minimization (zero contributor_count column)
// 6. Least-Privilege Role Boundary (abate_worker cannot read privacy tables)
// 7. Deterministic Arithmetic & Idempotent Query Replay

import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { compileRelease } from "../src/domains/privacy/compile-release";
import { withTenant, withWorker, memDb } from "../src/platform/db/with-tenant";
import { SemanticQuery } from "../src/contracts/release";

console.log("\x1b[36m=== Abate Task Runner: test-reconstruction (Reconstruction Attack Lab) ===\x1b[0m\n");

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

async function main() {
  // Step 1: Seed base two-tenant environment
  await runTest("Setup: Seed isolated two-tenant environment", async () => {
    await seedTwoTenants();
  });

  const tenantAId = GOLDEN_01.tenantA.id;
  const pStart = "2026-03-01T00:00:00Z";
  const pEnd = "2026-03-29T00:00:00Z"; // Exactly 28 days (4 weeks) for Class B

  // --------------------------------------------------------------------------
  // TEST 1: Single Individual Isolation Floor Gate (k >= 10)
  // --------------------------------------------------------------------------
  await runTest(
    "Floor Gate: n=9 cohort is suppressed with safe UNAVAILABLE; n=10 cohort releases",
    async () => {
      // 1. Attack 1: Query cohort with 9 members (n = 9)
      const members9 = Array.from({ length: 9 }, (_, i) => `emp-floor-attack-${i + 1}`);
      const qFloorFail: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:team-floor-9",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const res9 = await compileRelease(tenantAId, qFloorFail, members9);
      assert.strictEqual(res9.status, "UNAVAILABLE", "Cohort with 9 contributors must be suppressed");
      assert.strictEqual(res9.code, "NOT_AVAILABLE", "Caller must receive generic safe error code");
      assert.strictEqual(res9.releaseId, undefined, "No releaseId must be issued on suppression");

      // Verify privacy decision recorded reason internally but disclosed nothing
      await withTenant(tenantAId, async (tx) => {
        const dec = await tx.q(
          "SELECT outcome, reason_code FROM privacy_decision WHERE tenant_id = $1 ORDER BY decided_at DESC LIMIT 1",
          [tenantAId]
        );
        assert.strictEqual(dec.rows[0].outcome, "SUPPRESSED");
        assert.strictEqual(dec.rows[0].reason_code, "FLOOR");
      });

      // 2. Legitimate query: Cohort with 10 members (n = 10)
      const members10 = Array.from({ length: 10 }, (_, i) => `emp-floor-legit-${i + 1}`);
      const qFloorPass: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:team-floor-10",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const res10 = await compileRelease(tenantAId, qFloorPass, members10);
      assert.strictEqual(res10.status, "RELEASED", "Cohort with 10 contributors must be released");
      assert.ok(res10.releaseId, "Valid releaseId must be issued");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 2: Parent/Child Cohort Subtraction Attack (Residual Gate)
  // --------------------------------------------------------------------------
  await runTest(
    "Residual Gate: Parent (n=14) and Child (n=10) differ by residual 4 and child is suppressed",
    async () => {
      // Parent department: 14 employees
      const parentMembers = Array.from({ length: 14 }, (_, i) => `emp-dept-parent-${i + 1}`);
      const qParent: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:dept-parent-14",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const resParent = await compileRelease(tenantAId, qParent, parentMembers);
      assert.strictEqual(resParent.status, "RELEASED", "Parent department of 14 must be released");

      // Child sub-team: 10 of those 14 employees. Residual difference = 14 - 10 = 4 (< 5)
      const childMembers = parentMembers.slice(0, 10);
      const qChild: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:team-child-10",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const resChild = await compileRelease(tenantAId, qChild, childMembers);
      assert.strictEqual(
        resChild.status,
        "UNAVAILABLE",
        "Child cohort differing by residual 4 from parent must be suppressed to prevent isolating the 4 employees"
      );

      // Verify internal reason was RESIDUAL
      await withTenant(tenantAId, async (tx) => {
        const dec = await tx.q(
          "SELECT reason_code FROM privacy_decision WHERE tenant_id = $1 ORDER BY decided_at DESC LIMIT 1",
          [tenantAId]
        );
        assert.strictEqual(dec.rows[0].reason_code, "RESIDUAL");
      });
    }
  );

  // --------------------------------------------------------------------------
  // TEST 3: Overlapping Cohorts Differencing Attack (Symmetric Difference Gate)
  // --------------------------------------------------------------------------
  await runTest(
    "Overlap Gate: Two cohorts sharing 9 members (symmetric diff = 2) trigger suppression",
    async () => {
      // Base team: 9 common members
      const common = Array.from({ length: 9 }, (_, i) => `emp-overlap-common-${i + 1}`);
      const cohortA = [...common, "emp-overlap-unique-A"];
      const cohortB = [...common, "emp-overlap-unique-B"];

      // Query Cohort A (10 members)
      const qA: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:cohort-overlap-A",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const resA = await compileRelease(tenantAId, qA, cohortA);
      assert.strictEqual(resA.status, "RELEASED", "First cohort of 10 must release");

      // Query Cohort B (10 members, differing by only 1 person in each direction: symmetric diff = 2 < 5)
      const qB: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:cohort-overlap-B",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const resB = await compileRelease(tenantAId, qB, cohortB);
      assert.strictEqual(
        resB.status,
        "UNAVAILABLE",
        "Overlapping cohort with symmetric difference < 5 must be suppressed"
      );

      // Verify internal reason was OVERLAP
      await withTenant(tenantAId, async (tx) => {
        const dec = await tx.q(
          "SELECT reason_code FROM privacy_decision WHERE tenant_id = $1 ORDER BY decided_at DESC LIMIT 1",
          [tenantAId]
        );
        assert.strictEqual(dec.rows[0].reason_code, "OVERLAP");
      });
    }
  );

  // --------------------------------------------------------------------------
  // TEST 4: Advisory Lock Serialization Under Concurrent Racing Requests
  // --------------------------------------------------------------------------
  await runTest(
    "Serialization: Concurrent racing requests targeting overlapping cohorts are serialized",
    async () => {
      const common = Array.from({ length: 9 }, (_, i) => `emp-race-common-${i + 1}`);
      const cohortRace1 = [...common, "emp-race-1"];
      const cohortRace2 = [...common, "emp-race-2"];

      const q1: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:race-cohort-1",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };
      const q2: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:race-cohort-2",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      // Launch both requests simultaneously
      const [r1, r2] = await Promise.all([
        compileRelease(tenantAId, q1, cohortRace1),
        compileRelease(tenantAId, q2, cohortRace2)
      ]);

      // Exactly one must release, and the other must be suppressed by the disclosure ledger lock
      const statuses = [r1.status, r2.status].sort();
      assert.deepStrictEqual(
        statuses,
        ["RELEASED", "UNAVAILABLE"],
        "Advisory lock must serialize racing requests so that overlap differencing cannot be bypassed"
      );
    }
  );

  // --------------------------------------------------------------------------
  // TEST 5: Released Artifact Schema Minimization (Zero Contributor Count Column)
  // --------------------------------------------------------------------------
  await runTest(
    "Schema Minimization: released_artifact has 0 contributor_count column or individual IDs",
    async () => {
      const legitMembers = Array.from({ length: 12 }, (_, i) => `emp-schema-min-${i + 1}`);
      const qSchema: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:schema-minimization-team",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      const res = await compileRelease(tenantAId, qSchema, legitMembers);
      assert.strictEqual(res.status, "RELEASED");
      const releaseId = res.releaseId!;

      await withTenant(tenantAId, async (tx) => {
        const artRes = await tx.q("SELECT * FROM released_artifact WHERE release_id = $1", [releaseId]);
        assert.strictEqual(artRes.rowCount, 1, "Released artifact row must exist");

        const row = artRes.rows[0];
        // Confirm contributor_count does not exist in the public artifact table
        assert.strictEqual(row.contributor_count, undefined, "released_artifact MUST NOT have contributor_count column");

        // Confirm row has only safe approved public fields
        const keys = Object.keys(row);
        assert(!keys.includes("contributor_count"), "Columns must not include contributor_count");
        assert(!keys.includes("cohort_members"), "Columns must not include cohort_members");
        assert(!keys.includes("subject_pseudonym"), "Columns must not include subject_pseudonym");

        // Confirm value is present and valid
        assert.strictEqual(typeof row.value, "number");
        assert.strictEqual(row.quality, "VALID");
        assert.ok(row.artifact_hash, "Artifact hash must be present");
      });
    }
  );

  // --------------------------------------------------------------------------
  // TEST 6: Least-Privilege Role Boundary (abate_worker cannot read privacy tables)
  // --------------------------------------------------------------------------
  await runTest(
    "Role Boundary: abate_worker fails closed on all privacy tables (metric_snapshot, disclosure_ledger, privacy_decision)",
    async () => {
      // 1. Worker tries to query metric_snapshot
      const snapRes = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM metric_snapshot")).rows;
      });
      assert.strictEqual(snapRes.length, 0, "abate_worker MUST NOT be able to read metric_snapshot");

      // 2. Worker tries to query disclosure_ledger
      const ledgerRes = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM disclosure_ledger")).rows;
      });
      assert.strictEqual(ledgerRes.length, 0, "abate_worker MUST NOT be able to read disclosure_ledger");

      // 3. Worker tries to query privacy_decision
      const decRes = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM privacy_decision")).rows;
      });
      assert.strictEqual(decRes.length, 0, "abate_worker MUST NOT be able to read privacy_decision");

      // 4. Worker tries to query privacy_release
      const relRes = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM privacy_release")).rows;
      });
      assert.strictEqual(relRes.length, 0, "abate_worker MUST NOT be able to read privacy_release");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 7: Deterministic Arithmetic & Idempotent Query Replay
  // --------------------------------------------------------------------------
  await runTest(
    "Idempotency: Re-submitting identical query returns cached release without duplicate ledger rows",
    async () => {
      const members = Array.from({ length: 11 }, (_, i) => `emp-idempotent-${i + 1}`);
      const q: SemanticQuery = {
        metricId: "BOUNDARY_INTRUSION_SHARE",
        metricVersion: 1,
        cohortRef: "org:idempotent-cohort",
        periodStart: pStart,
        periodEnd: pEnd,
        releaseClass: "CLASS_B"
      };

      // Initial query
      const res1 = await compileRelease(tenantAId, q, members);
      assert.strictEqual(res1.status, "RELEASED");

      // Count disclosure ledger entries before replay
      let countBefore = 0;
      await withTenant(tenantAId, async (tx) => {
        const rows = await tx.q("SELECT id FROM disclosure_ledger WHERE tenant_id = $1", [tenantAId]);
        countBefore = rows.rowCount ?? 0;
      });

      // Second identical query
      const res2 = await compileRelease(tenantAId, q, members);
      assert.strictEqual(res2.status, "RELEASED");
      assert.strictEqual(res2.releaseId, res1.releaseId, "Must return identical release ID on cache replay");

      // Count disclosure ledger entries after replay: must not increase
      await withTenant(tenantAId, async (tx) => {
        const rows = await tx.q("SELECT id FROM disclosure_ledger WHERE tenant_id = $1", [tenantAId]);
        assert.strictEqual(rows.rowCount, countBefore, "Disclosure ledger must not grow on query replay");
      });
    }
  );

  console.log(`\n\x1b[32m[SUCCESS] All ${passed}/7 Reconstruction Attack Lab tests PASSED.\x1b[0m\n`);
}

main().catch((err) => {
  console.error("\x1b[31m[RECONSTRUCTION LAB FAILED]\x1b[0m", err);
  process.exit(1);
});

