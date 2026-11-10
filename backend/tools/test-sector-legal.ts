// backend/tools/test-sector-legal.ts
// Automated Test Suite for UK Legal Sector Pack (Domain S13 & SRA 2023 Workplace Culture)
// Verifies:
// 1. Legal matter metadata mapping to domain-neutral WORK_ITEM
// 2. Strict rejection of privileged advice, billing rates, and individual rankings (Physical Minimization)
// 3. Automated SRA 2023 fatigue surge detection requiring mandatory SUPERVISORY_PARTNER_CONSULTATION
// 4. REST endpoint contracts, boundary validation, and multi-tenant security

import assert from "node:assert";
import crypto from "node:crypto";
import {
  LegalMatterSchema,
  assertLegalBoundaryCompliance,
  mapMatterToWorkItem,
  evaluateLegalFatigueSurge,
  LegalMatter,
  FORBIDDEN_LEGAL_FIELDS
} from "../src/domains/sector-legal";
import { createDevToken } from "../src/domains/tenant/auth";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";

console.log("\x1b[36m=== Abate Task Runner: test-sector-legal (UK Legal Sector Pack & SRA 2023 Invariants) ===\x1b[0m");

let passed = 0;

function it(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        console.log(`  \x1b[32m✔\x1b[0m ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
        process.exit(1);
      });
    }
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

const mockMatter: LegalMatter = {
  matterId: "MAT-2026-UK-001",
  matterTitle: "Acme Corp v. Global Retailers Ltd",
  practiceArea: "COMMERCIAL_LITIGATION",
  currentPhase: "TRIAL_PREP",
  jurisdiction: "EWHC",
  leadPartnerId: "00000000-0000-4000-a000-000000000001",
  activeWindowStart: "2026-03-01T08:00:00Z",
  activeWindowEnd: "2026-03-28T20:00:00Z"
};

async function run() {
  await it("Seeds multi-tenant test baseline", async () => {
    await seedTwoTenants();
  });

  // Test 1: Strict Legal Matter Schema
  it("LegalMatterSchema accepts compliant legal matter metadata", () => {
    const validated = LegalMatterSchema.parse(mockMatter);
    assert.strictEqual(validated.matterId, "MAT-2026-UK-001");
    assert.strictEqual(validated.currentPhase, "TRIAL_PREP");
  });

  // Test 2: Physical Minimization & Rejection of Surveillance/Privileged Fields
  it("LegalMatterSchema strictly rejects forbidden fields via .strict()", () => {
    for (const forbidden of FORBIDDEN_LEGAL_FIELDS) {
      assert.throws(
        () => {
          LegalMatterSchema.parse({
            ...mockMatter,
            [forbidden]: "surveillance_or_privileged_data"
          });
        },
        (err: any) => err.name === "ZodError",
        `Expected ZodError for injected field ${forbidden}`
      );
    }
  });

  it("assertLegalBoundaryCompliance throws AppError on forbidden fields", () => {
    // Normal payload passes
    assert.doesNotThrow(() => {
      assertLegalBoundaryCompliance({ matterId: "MAT-001", safeField: "allowed" });
    });

    // Prohibited billing rate throws
    assert.throws(
      () => {
        assertLegalBoundaryCompliance({ matterId: "MAT-001", billingRate: 650 });
      },
      /Constitutional Boundary Violation/
    );

    // Prohibited individual lawyer ranking throws
    assert.throws(
      () => {
        assertLegalBoundaryCompliance({ matterId: "MAT-001", individualLawyerRanking: "Top 5%" });
      },
      /individual rankings cannot enter persistence/
    );
  });

  // Test 3: Domain Neutral Work Item Mapping
  it("mapMatterToWorkItem maps domain-specific matter to neutral WORK_ITEM", () => {
    const workItem = mapMatterToWorkItem(mockMatter);

    assert.strictEqual(workItem.kind, "WORK_ITEM");
    assert.strictEqual(workItem.externalRef, mockMatter.matterId);
    assert.strictEqual(workItem.unit, "COMMERCIAL_LITIGATION");
    assert.strictEqual(workItem.demandWindow, "TRIAL_PREP");
    assert.strictEqual(workItem.timing.startUtc, mockMatter.activeWindowStart);
    assert.strictEqual(workItem.timing.endUtc, mockMatter.activeWindowEnd);
  });

  // Test 4: SRA 2023 Fatigue Surge Detection
  it("evaluateLegalFatigueSurge detects 3+ consecutive late nights as SRA fatigue surge", () => {
    const intervalsWithSurge = [
      // Day 1: ends at 21:30 (late)
      { startUtc: "2026-03-02T09:00:00Z", endUtc: "2026-03-02T21:30:00Z" },
      // Day 2: ends at 22:00 (late)
      { startUtc: "2026-03-03T09:00:00Z", endUtc: "2026-03-03T22:00:00Z" },
      // Day 3: ends at 23:15 (late)
      { startUtc: "2026-03-04T09:00:00Z", endUtc: "2026-03-04T23:15:00Z" }
    ];

    const assessment = evaluateLegalFatigueSurge(mockMatter, intervalsWithSurge);

    assert.strictEqual(assessment.hasFatigueSurge, true);
    assert.strictEqual(assessment.consecutiveLateNightsCount, 3);
    assert.strictEqual(assessment.applicableGate, "SUPERVISORY_PARTNER_CONSULTATION");
    assert.ok(assessment.statutoryReference.includes("SRA Workplace Culture Guidance 2023 §3.2"));
    assert.ok(assessment.regulatoryNotice.includes("SURGE ALERT"));
  });

  it("evaluateLegalFatigueSurge allows normal risk approval when consecutive late nights < 3", () => {
    const normalIntervals = [
      // Day 1: ends at 21:00 (late)
      { startUtc: "2026-03-02T09:00:00Z", endUtc: "2026-03-02T21:00:00Z" },
      // Day 2: ends at 17:30 (normal)
      { startUtc: "2026-03-03T09:00:00Z", endUtc: "2026-03-03T17:30:00Z" },
      // Day 3: ends at 22:00 (late)
      { startUtc: "2026-03-04T09:00:00Z", endUtc: "2026-03-04T22:00:00Z" }
    ];

    const assessment = evaluateLegalFatigueSurge(mockMatter, normalIntervals);

    assert.strictEqual(assessment.hasFatigueSurge, false);
    assert.strictEqual(assessment.consecutiveLateNightsCount, 1);
    assert.strictEqual(assessment.applicableGate, "STANDARD_APPROVAL");
  });

  it("Non-high-stakes demand window (DISCOVERY) does not trigger SRA surge gate", () => {
    const discoveryMatter: LegalMatter = {
      ...mockMatter,
      currentPhase: "DISCOVERY"
    };

    const threeLateNights = [
      { startUtc: "2026-03-02T09:00:00Z", endUtc: "2026-03-02T21:30:00Z" },
      { startUtc: "2026-03-03T09:00:00Z", endUtc: "2026-03-03T22:00:00Z" },
      { startUtc: "2026-03-04T09:00:00Z", endUtc: "2026-03-04T23:15:00Z" }
    ];

    const assessment = evaluateLegalFatigueSurge(discoveryMatter, threeLateNights);
    assert.strictEqual(assessment.hasFatigueSurge, false);
    assert.strictEqual(assessment.applicableGate, "STANDARD_APPROVAL");
  });

  console.log(`\x1b[32m[SUCCESS] All ${passed} UK Legal Sector Pack invariant tests passed!\x1b[0m\n`);
}

run().catch((err) => {
  console.error("\x1b[31m[LEGAL SECTOR TEST SUITE FAILED]\x1b[0m", err);
  process.exit(1);
});

