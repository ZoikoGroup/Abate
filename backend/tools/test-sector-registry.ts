// backend/tools/test-sector-registry.ts
// Verifies the sector pack registry: any registered sector resolves without code changes,
// and no pack can weaken the constitutional floor.
import assert from "node:assert";
import {
  registerSectorPack,
  getSectorMapping,
  listAvailableSectors,
  resolveTenantSectorProfile,
  setTenantSectorSetting,
  assertTenantHasSectorPack,
  assertTenantHasLegalPack,
  describeSectorScope,
  genericMapping,
  legalMapping,
  accountingMapping
} from "../src/domains/lifecycle/sector";
import { CORE_FORBIDDEN_FIELDS, SectorPackDefinition } from "../src/domains/lifecycle/sector-pack";
import { detectSectorByBindings } from "../src/domains/lifecycle/sector-registry";
import { buildWorkItemSchema } from "../src/domains/sector-work";
import { withTenant } from "../src/platform/db/with-tenant";
import { seedTwoTenants } from "../src/fixtures/seed";

console.log("\x1b[36m=== Abate Task Runner: test-sector-registry (Sector Pack Registry Invariants) ===\x1b[0m");

let passed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

// A synthetic sector used only to prove registration needs no resolver or endpoint change.
// Its content is test data, not a launched pack and not regulatory content.
const syntheticPack: SectorPackDefinition = {
  sectorKey: "SYNTHETIC_TEST",
  packKey: "synthetic-test-pack",
  acceptedPackKeys: ["synthetic-test-pack"],
  bindingMatchers: ["synthetic"],
  status: "FIXTURE",
  displayName: "Synthetic Test Sector",
  vocabulary: { workItem: "Case", workItems: "Cases", unit: "Ward", demandWindow: "Surge Window", supervisor: "Charge Lead" },
  workItemFields: { externalRef: ["caseId"], unit: ["ward"] },
  demandWindows: ["SURGE", "BASELINE_FLOW"],
  highDemandWindows: ["SURGE"],
  fatigueRule: { highDemandWindows: ["SURGE"], consecutiveLateNights: 2, lateEveningUtcHour: 21, earlyMorningUtcHour: 5 },
  forbidden: ["patientIdentifier"],
  requiredGates: ["APPROVAL", "REVIEW"],
  claimScope: "Synthetic test sector.",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};

async function run() {
  await it("built-in packs keep their previous behaviour", () => {
    assert.strictEqual(genericMapping.sector, "GENERIC");
    assert.strictEqual(legalMapping.vocabulary.workItem, "Matter");
    assert.strictEqual(accountingMapping.vocabulary.workItem, "Engagement");
    assert.deepStrictEqual(legalMapping.workItem.fromEntity({ matterId: "M1", practiceArea: "ARBITRATION" }),
      { kind: "WORK_ITEM", externalRef: "M1", unit: "ARBITRATION" });
    assert.deepStrictEqual(genericMapping.workItem.fromEntity({}),
      { kind: "WORK_ITEM", externalRef: "WORK-ITEM-UNKNOWN", unit: "GENERAL_TEAM" });
    assert.ok(genericMapping.claimScope.includes("UK Legal Sector Pack"));
  });

  await it("every pack inherits the core forbidden fields", () => {
    for (const s of listAvailableSectors()) {
      const m = getSectorMapping(s.sectorKey)!;
      for (const f of CORE_FORBIDDEN_FIELDS) assert.ok(m.forbidden.includes(f), `${s.sectorKey} missing ${f}`);
    }
    assert.ok(legalMapping.forbidden.includes("individualScore"));
  });

  await it("a new sector registers with no resolver or endpoint change", async () => {
    registerSectorPack(syntheticPack);
    const m = getSectorMapping("SYNTHETIC_TEST")!;
    assert.strictEqual(m.vocabulary.workItem, "Case");
    assert.ok(m.forbidden.includes("patientIdentifier"));
    assert.ok(m.forbidden.includes("individualScore"));
    assert.deepStrictEqual(m.workItem.fromEntity({ caseId: "C-9", ward: "W3" }), { kind: "WORK_ITEM", externalRef: "C-9", unit: "W3" });
    assert.ok(listAvailableSectors().some(s => s.sectorKey === "SYNTHETIC_TEST"));
  });

  await it("preview packs for Healthcare and Software/IT are registered but never claimed as launched", () => {
    const sectors = listAvailableSectors();
    for (const key of ["HEALTHCARE", "SOFTWARE_IT"]) {
      const entry = sectors.find(s => s.sectorKey === key);
      assert.ok(entry, `${key} registered`);
      assert.strictEqual(entry!.status, "PREVIEW");
      assert.match(getSectorMapping(key)!.claimScope, /pending Legal & Policy Lead review/);
    }
    assert.ok(getSectorMapping("HEALTHCARE")!.forbidden.includes("patientIdentifier"));
    assert.ok(getSectorMapping("HEALTHCARE")!.forbidden.includes("individualScore"), "core field inherited");
    assert.ok(getSectorMapping("SOFTWARE_IT")!.forbidden.includes("individualVelocity"));
    assert.ok(getSectorMapping("SOFTWARE_IT")!.forbidden.includes("keystrokeLogs"), "core field inherited");
    // Only the legal pack counts as launched. Preview and fixture packs never appear in the claim.
    assert.ok(genericMapping.claimScope.includes("UK Legal Sector Pack"));
    assert.ok(!/Healthcare|Software/.test(genericMapping.claimScope), "preview packs are not claimed");
  });

  await it("the scope statement lists launched packs apart from previews pending review", () => {
    const scope = describeSectorScope();
    const [launched, preview] = scope.split("; preview packs pending policy review: ");
    assert.ok(launched.includes("UK Legal Sector Pack (SRA 2023)"));
    assert.ok(!/Healthcare|Software|Accounting/.test(launched), "no preview or fixture pack in the launched list");
    assert.ok(preview.includes("Healthcare Sector Pack (Preview)") && preview.includes("Software & IT Sector Pack (Preview)"));
  });

  await it("a preview pack may not set a launch tag, and a launched pack must", () => {
    const base = { ...syntheticPack, sectorKey: "PREVIEW_TAG", packKey: "preview-tag-pack", acceptedPackKeys: ["preview-tag-pack"] };
    assert.throws(() => registerSectorPack({ ...base, status: "PREVIEW", launchTag: "PREVIEW_TAG" }), /only a LAUNCHED pack may set a launchTag/);
    assert.throws(() => registerSectorPack({ ...base, status: "LAUNCHED" }), /requires a launchTag/);
  });

  await it("every registered pack accepts a valid work item and refuses another pack's demand windows", () => {
    const sectors = listAvailableSectors();
    assert.ok(sectors.length >= 6, "generic, legal, healthcare, software, accounting and the synthetic pack");
    for (const s of sectors) {
      const mine = getSectorMapping(s.sectorKey)!;
      const schema = buildWorkItemSchema(mine);
      const item = {
        externalRef: "REF-1", title: "Synthetic item",
        unit: mine.workItemUnits[0] ?? "ANY_UNIT",
        demandWindow: mine.demandWindows[0],
        accountableReviewerId: "00000000-0000-4000-a000-000000000001",
        activeWindowStart: "2026-03-01T08:00:00Z", activeWindowEnd: "2026-03-02T08:00:00Z"
      };
      assert.ok(schema.safeParse(item).success, `${s.sectorKey} accepts its own first window`);
      for (const other of sectors) {
        if (other.sectorKey === s.sectorKey) continue;
        const theirs = getSectorMapping(other.sectorKey)!;
        const foreign = theirs.demandWindows.find(w => !mine.demandWindows.includes(w));
        if (!foreign) continue;
        assert.ok(!schema.safeParse({ ...item, demandWindow: foreign }).success, `${s.sectorKey} must refuse ${other.sectorKey} window ${foreign}`);
      }
    }
  });

  await it("rejects duplicate sector keys and pack keys owned by another sector", () => {
    assert.throws(() => registerSectorPack(syntheticPack), /already registered/);
    assert.throws(
      () => registerSectorPack({ ...syntheticPack, sectorKey: "OTHER_TEST", acceptedPackKeys: ["synthetic-test-pack"], packKey: "synthetic-test-pack" }),
      /already belongs to/
    );
  });

  await it("rejects packs that lower the privacy floor or expand AI authority", () => {
    assert.throws(() => registerSectorPack({ ...syntheticPack, sectorKey: "BAD_ONE", privacyFloor: 3 }), /cannot lower privacyFloor/);
    assert.throws(() => registerSectorPack({ ...syntheticPack, sectorKey: "BAD_TWO", aiAuthority: "EXPANDED" }), /cannot expand AI authority/);
  });

  await it("rejects malformed definitions", () => {
    const base = { ...syntheticPack, sectorKey: "BAD_SHAPE", packKey: "bad-shape-pack", acceptedPackKeys: ["bad-shape-pack"] };
    assert.throws(() => registerSectorPack({ ...base, sectorKey: "lower" }), /Sector pack rejected/);
    assert.throws(() => registerSectorPack({ ...base, highDemandWindows: ["NOT_DECLARED"] }), /not a declared demand window/);
    assert.throws(() => registerSectorPack({ ...base, acceptedPackKeys: ["something-else"] }), /must include packKey/);
    assert.throws(() => registerSectorPack({ ...base, status: "LAUNCHED" }), /launchTag/);
    assert.throws(() => registerSectorPack({ ...base, bindingMatchers: [] }), /bindingMatcher/);
    assert.throws(() => registerSectorPack({ ...base, cannotOverride: ["privacyFloor"] }), /Sector pack rejected/);
    assert.throws(() => registerSectorPack({ ...base, unexpectedField: true }), /Sector pack rejected/);
  });

  await it("screen copy: legal keeps its exact wording, other sectors get defaults from their vocabulary", () => {
    assert.strictEqual(legalMapping.ui.navLabel, "Legal Sector Pack (SRA 2023)");
    assert.strictEqual(legalMapping.ui.fatigueButtonLabel, "SRA Fatigue Check");
    assert.strictEqual(legalMapping.ui.unitLabels.CORPORATE_MA, "Corporate M&A");
    assert.deepStrictEqual(legalMapping.ui.decoyFields.map(d => d.field), ["privilegedAdvice", "billingRate", "individualLawyerRanking"]);
    const synth = getSectorMapping("SYNTHETIC_TEST")!;
    assert.strictEqual(synth.ui.navLabel, "Synthetic Test Sector");
    assert.ok(synth.ui.listTitle.startsWith("Cases"));
    assert.ok(synth.ui.consultationTitle.includes("Charge Lead"));
    assert.ok(synth.ui.thresholdNote.includes("2 consecutive nights") && synth.ui.thresholdNote.includes("21:00"));
    assert.strictEqual(synth.ui.consultationSignerDefault, "");
    for (const s of listAvailableSectors()) {
      const m = getSectorMapping(s.sectorKey)!;
      assert.strictEqual(m.ui.consultationSignerDefault, "", `${s.sectorKey} must not ship a person's name`);
      assert.ok(m.ui.decoyFields.every(d => m.forbidden.includes(d.field) || d.field === "individualScore"), `${s.sectorKey} decoys must be forbidden fields`);
    }
    for (const forbiddenLegal of ["Jane", "Doe"]) {
      assert.ok(!JSON.stringify(legalMapping.ui).includes(forbiddenLegal));
    }
  });

  await it("rejects ui.unitLabels keys that are not declared units", () => {
    const base = { ...syntheticPack, sectorKey: "BAD_LABELS", packKey: "bad-labels-pack", acceptedPackKeys: ["bad-labels-pack"], workItemUnits: ["WARD_3"] };
    assert.throws(() => registerSectorPack({ ...base, ui: { unitLabels: { WARD_9: "Ward Nine" } } }), /not a declared work item unit/);
    assert.throws(() => registerSectorPack({ ...base, ui: { notACopyField: "x" } }), /Sector pack rejected/);
  });

  await it("binding detection matches whole words only", () => {
    assert.strictEqual(detectSectorByBindings(["legal-uk-sra"])?.sector, "LEGAL");
    assert.strictEqual(detectSectorByBindings(["sector-legal"])?.sector, "LEGAL");
    assert.strictEqual(detectSectorByBindings(["legal-uk-bar"])?.sector, "LEGAL");
    assert.strictEqual(detectSectorByBindings(["accounting-fixture"])?.sector, "ACCOUNTING");
    assert.strictEqual(detectSectorByBindings(["debarment-policy", "barclays-pack"]), undefined);
    assert.strictEqual(detectSectorByBindings(["generic-work-design"]), undefined);
    assert.strictEqual(detectSectorByBindings(["healthcare-preview"])?.sector, "HEALTHCARE");
    assert.strictEqual(detectSectorByBindings(["software-it-preview"])?.sector, "SOFTWARE_IT");
    assert.strictEqual(detectSectorByBindings(["legal-uk-sra", "healthcare-preview"])?.sector, "LEGAL", "registration order is the priority");
    assert.strictEqual(detectSectorByBindings(["synthetic-anything"])?.sector, "SYNTHETIC_TEST");
  });

  const seeded = await seedTwoTenants();
  const tenantA: string = seeded.tenantA.tenant.id;
  const tenantB: string = seeded.tenantB.tenant.id;

  // A persistent database keeps these rows between runs, so put both tenants back on their legal packs
  // when finished. Otherwise later suites would find tenant A on GENERIC and tenant B on a retired sector.
  const restoreSectors = async () => {
    await withTenant(tenantA, (tx) => setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "LEGAL", packKey: "legal-uk-sra" }));
    await withTenant(tenantB, (tx) => setTenantSectorSetting(tx, { tenantId: tenantB, sectorKey: "LEGAL", packKey: "legal-uk-bar" }));
  };
  try {

  await it("tenant with a legal binding and no setting resolves to LEGAL", async () => {
    await withTenant(tenantA, async (tx) => {
      const p = await resolveTenantSectorProfile(tx, tenantA);
      assert.strictEqual(p.sectorKey, "LEGAL");
      assert.strictEqual(p.packActive, true);
      assert.strictEqual(p.hasLegalPack, true);
      assert.deepStrictEqual(p.enabledSectors, ["LEGAL_UK"]);
      assert.ok(p.availableSectors.some(s => s.sectorKey === "SYNTHETIC_TEST"));
    });
  });

  await it("an explicit setting selects any registered sector and drives the profile", async () => {
    await withTenant(tenantA, async (tx) => {
      await setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "SYNTHETIC_TEST", packKey: "synthetic-test-pack" });
      const p = await resolveTenantSectorProfile(tx, tenantA);
      assert.strictEqual(p.sectorKey, "SYNTHETIC_TEST");
      assert.strictEqual(p.hasLegalPack, false);
      assert.strictEqual(p.packActive, true);
      assert.strictEqual(p.vocabulary.workItem, "Case");
      assert.deepStrictEqual(p.highDemandWindows, ["SURGE"]);
      assert.strictEqual(p.ui.navLabel, "Synthetic Test Sector");
      assert.deepStrictEqual(p.workItemUnits, []);
      await assertTenantHasSectorPack(tx, tenantA, "SYNTHETIC_TEST");
      await assert.rejects(() => assertTenantHasSectorPack(tx, tenantA, "LEGAL"), /not enabled for this tenant/);
      await assert.rejects(() => assertTenantHasLegalPack(tx, tenantA), /Legal Sector Pack is not enabled/);
    });
  });

  await it("GENERIC setting returns the neutral profile", async () => {
    await withTenant(tenantA, async (tx) => {
      await setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "GENERIC", packKey: "generic-work-design" });
      const p = await resolveTenantSectorProfile(tx, tenantA);
      assert.strictEqual(p.sectorKey, "GENERIC");
      assert.strictEqual(p.packActive, false);
      assert.strictEqual(p.vocabulary.workItem, "Work Item");
    });
  });

  await it("refuses to save an unknown sector or a pack key from another sector", async () => {
    await withTenant(tenantA, async (tx) => {
      await assert.rejects(() => setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "NO_SUCH_SECTOR", packKey: "x-pack" }), /Unknown sector/);
      await assert.rejects(() => setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "LEGAL", packKey: "accounting-fixture" }), /does not belong to sector/);
    });
  });

  await it("a stored sector that is no longer registered fails closed to GENERIC", async () => {
    await withTenant(tenantB, async (tx) => {
      // Simulates a retired pack: write the row directly, bypassing registry validation.
      await tx.q(
        `INSERT INTO tenant_sector_setting (tenant_id, sector_key, pack_key, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET sector_key = EXCLUDED.sector_key, pack_key = EXCLUDED.pack_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenantB, "RETIRED_SECTOR", "retired-pack", null]
      );
      const p = await resolveTenantSectorProfile(tx, tenantB);
      assert.strictEqual(p.sectorKey, "GENERIC");
      assert.strictEqual(p.packActive, false);
    });
  });

  } finally {
    await restoreSectors();
  }

  console.log(`\n\x1b[32mAll ${passed} sector registry invariants passed.\x1b[0m`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
