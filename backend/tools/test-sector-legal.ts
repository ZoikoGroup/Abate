// backend/tools/test-sector-legal.ts
// Automated Test Suite for UK Legal Sector Pack (Domain S13 & SRA 2023 Workplace Culture)
// Verifies:
// 1. Legal matter metadata mapping to domain-neutral WORK_ITEM
// 2. Strict rejection of privileged advice, billing rates, and individual rankings (Physical Minimization)
// 3. Automated SRA 2023 fatigue surge detection requiring mandatory SUPERVISORY_PARTNER_CONSULTATION
// 4. REST endpoint contracts, boundary validation, and multi-tenant security

import assert from "node:assert";
import {
  LegalMatterSchema,
  assertLegalBoundaryCompliance,
  mapMatterToWorkItem,
  evaluateLegalFatigueSurge,
  LegalMatter,
  FORBIDDEN_LEGAL_FIELDS
} from "../src/domains/sector-legal";
import {
  accountingMapping,
  genericMapping,
  evaluateNeutralFatigueSurge,
  resolveTenantSectorProfile,
  setTenantSectorSetting,
  assertTenantHasLegalPack,
  validateSectorPack
} from "../src/domains/lifecycle/sector";
import { withTenant } from "../src/platform/db/with-tenant";
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

  // Test 9: Generic / Accounting Portability Fixture (Tenant C with NO Legal pack)
  await it("Non-legal Tenant C runs neutral work-item + fatigue rule without legal terms or core code forks", async () => {
    const tenantCId = "00000000-0000-4000-c000-00000000000c";
    await withTenant(tenantCId, async (tx) => {
      await tx.q(
        `INSERT INTO tenant (id, name, region, jurisdiction_config_ref) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tenantCId, "Northbridge Accounting (Tenant C)", "eu-west-2", "generic-work-design"]
      );
      const profile = await resolveTenantSectorProfile(tx, tenantCId);
      assert.strictEqual(profile.hasLegalPack, false);
      assert.strictEqual(profile.sectorKey, "GENERIC");
      assert.strictEqual(profile.vocabulary.workItem, "Work Item");
      assert.ok(!JSON.stringify(profile.vocabulary).toLowerCase().includes("matter"));
      assert.ok(!JSON.stringify(profile.vocabulary).toLowerCase().includes("partner"));

      await assert.rejects(
        () => assertTenantHasLegalPack(tx, tenantCId),
        (err: any) => err?.code === "FORBIDDEN",
        "Legal endpoints must reject a non-legal tenant with FORBIDDEN"
      );
    });

    // Accounting fixture runs through the neutral engine cleanly
    const neutralWorkItem = accountingMapping.workItem.fromEntity({
      engagementId: "ENG-2026-AUDIT-11",
      serviceLine: "TAX_ADVISORY"
    });
    assert.strictEqual(neutralWorkItem.kind, "WORK_ITEM");
    assert.strictEqual(neutralWorkItem.externalRef, "ENG-2026-AUDIT-11");
    assert.strictEqual(neutralWorkItem.unit, "TAX_ADVISORY");

    const neutralFatigue = evaluateNeutralFatigueSurge(
      { workItemId: neutralWorkItem.externalRef, unit: neutralWorkItem.unit, demandWindow: "BUSY_SEASON" },
      [
        { startUtc: "2026-03-02T09:00:00Z", endUtc: "2026-03-02T21:30:00Z" },
        { startUtc: "2026-03-03T09:00:00Z", endUtc: "2026-03-03T22:15:00Z" },
        { startUtc: "2026-03-04T09:00:00Z", endUtc: "2026-03-04T23:00:00Z" }
      ],
      accountingMapping.fatigueRule
    );
    assert.strictEqual(neutralFatigue.hasFatigueSurge, true);
    assert.strictEqual(neutralFatigue.consecutiveLateNightsCount, 3);
    assert.ok(genericMapping.claimScope.includes("UK Legal Sector Pack"));
  });

  // Test 10: Tenant A still resolves Legal Sector Pack & sector pack cannot weaken privacy or expand AI authority
  await it("Legal tenant resolves Legal pack while validateSectorPack blocks privacy/AI downgrades", async () => {
    await withTenant(GOLDEN_01.tenantA.id, async (tx) => {
      const profileA = await resolveTenantSectorProfile(tx, GOLDEN_01.tenantA.id);
      assert.strictEqual(profileA.hasLegalPack, true);
      assert.strictEqual(profileA.sectorKey, "LEGAL");
    });

    assert.throws(
      () => validateSectorPack({ privacyFloor: 5 }),
      /cannot lower privacyFloor/
    );
    assert.throws(
      () => validateSectorPack({ aiAuthority: "EXPANDED" }),
      /cannot expand AI authority/
    );
  });

  // Test 11: Two same-region tenants using tenant_sector_setting behave differently without code branches
  await it("Same-region tenants with distinct tenant_sector_setting rows resolve distinct vocabularies and gates", async () => {
    const tenantDId = "00000000-0000-4000-d000-00000000000d";
    await withTenant(tenantDId, async (tx) => {
      await tx.q(
        `INSERT INTO tenant (id, name, region, jurisdiction_config_ref) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tenantDId, "AuditCo Advisory (Tenant D)", "eu-west-2", "generic-work-design"]
      );
      await setTenantSectorSetting(tx, {
        tenantId: tenantDId,
        sectorKey: "ACCOUNTING",
        packKey: "accounting-fixture"
      });
      const profileD = await resolveTenantSectorProfile(tx, tenantDId);
      assert.strictEqual(profileD.sectorKey, "ACCOUNTING");
      assert.strictEqual(profileD.hasLegalPack, false);
      assert.strictEqual(profileD.vocabulary.workItem, "Engagement");
      assert.strictEqual(profileD.vocabulary.unit, "Service Line");
    });
  });

  console.log(`\x1b[32m[SUCCESS] All ${passed} Legal Sector Pack & Sector-Neutral Core invariant tests passed!\x1b[0m\n`);
}

run().catch((err) => {
  console.error("\x1b[31m[LEGAL SECTOR TEST SUITE FAILED]\x1b[0m", err);
  process.exit(1);
});

