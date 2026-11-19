// frontend/tests/sector-pack.test.tsx
// Contract test between sector packs and the screens that render them.
// Profiles are built from the real backend pack registry, so a copy change in a pack shows up here.
// Verifies:
//  1. The legal pack renders with its exact legal wording, units and decoy fields.
//  2. Another sector renders from defaults built from its own vocabulary, with no legal text anywhere.
//  3. The sector selector lists what the backend reports and flags test fixtures.
//  4. The sector screens contain no sector-specific words in their source.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SectorPackTab } from "../src/components/Tabs/SectorPackTab";
import { SectorPackSelector } from "../src/components/SectorPackSelector";
import { NEUTRAL_UI, getSectorUi, isSectorPackActive, labelFor } from "../src/utils/vocabulary";
import type { TenantSectorProfile } from "../src/api/client";
import { getSectorMapping, listAvailableSectors, registerSectorPack } from "../../backend/src/domains/lifecycle/sector";

// The test runner compiles JSX with the classic transform; the app build uses the automatic one.
(globalThis as any).React = React;

function profileFor(sectorKey: string): TenantSectorProfile {
  const m = getSectorMapping(sectorKey)!;
  const available = listAvailableSectors();
  return {
    tenantId: "t-test",
    sectorKey,
    packKey: m.packKey,
    displayName: available.find(a => a.sectorKey === sectorKey)!.displayName,
    packActive: sectorKey !== "GENERIC",
    hasLegalPack: sectorKey === "LEGAL",
    activePacks: [m.packKey],
    vocabulary: m.vocabulary,
    demandWindows: m.demandWindows,
    highDemandWindows: m.highDemandWindows,
    workItemUnits: m.workItemUnits,
    ui: m.ui,
    claimScope: m.claimScope,
    enabledSectors: ["LEGAL_UK"],
    availableSectors: available
  };
}

const tenant = { id: "t-test", name: "Test Tenant" } as any;
const render = (p: TenantSectorProfile) =>
  renderToStaticMarkup(React.createElement(SectorPackTab, { currentTenant: tenant, token: "tok", sectorProfile: p }));

function run() {
  // Registered at runtime: proves a brand-new sector renders with no frontend change.
  registerSectorPack({
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
  });

  // 1. Legal pack keeps its exact wording
  const legal = render(profileFor("LEGAL"));
  for (const text of [
    "UK Legal Practice &amp; Workplace Culture (SRA 2023 / Domain S13)",
    "SRA-Aligned Work-Design Review",
    "Legal Matters &amp; Demand Windows",
    "Constitutional Boundary Protection for Legal Services:",
    'aria-label="Filter Practice Area"',
    "All Practice Areas",
    "Corporate M&amp;A",
    "Commercial Litigation",
    "SRA 2023 Workplace Culture Fatigue Audit",
    "Inject Privileged Legal Advice",
    "Inject Hourly Billing Rate",
    "billingRate: 950",
    "Inject Individual Lawyer Ranking",
    "individualLawyerRanking: 1"
  ]) {
    assert.ok(legal.includes(text), `legal screen missing: ${text}`);
  }
  assert.ok(!legal.includes("Jane Doe"), "no person's name ships in the legal screen");

  // 2. Another sector renders from its own vocabulary with no legal wording at all
  const synth = render(profileFor("SYNTHETIC_TEST"));
  for (const text of ["Synthetic Test Sector: Cases", "Cases &amp; Demand Windows", "Inject Individual Productivity Score"]) {
    assert.ok(synth.includes(text), `synthetic screen missing: ${text}`);
  }
  assert.ok(!synth.includes("aria-label=\"Filter"), "no unit filter when the pack declares no units");
  const banned = /legal|matter|lawyer|solicitor|\bSRA\b|partner|attorney|barrister|billing/i;
  const hit = synth.match(banned);
  assert.ok(!hit, `synthetic screen leaked sector wording: ${hit?.[0]}`);

  // 2b. Preview packs render from the same screen with their own vocabulary and no legal wording
  for (const [key, expects] of [
    ["HEALTHCARE", ["Healthcare Sector Pack (Preview): Care Episodes", "Inject Patient Identifier", "Inject Clinical Notes", "Clinical Lead"]],
    ["SOFTWARE_IT", ["Software &amp; IT Sector Pack (Preview): Delivery Items", "Inject Source Code", "Inject Individual Velocity", "Engineering Manager"]]
  ] as const) {
    const html = render(profileFor(key));
    for (const text of expects) assert.ok(html.includes(text), `${key} screen missing: ${text}`);
    const leak = html.match(/legal|matter|lawyer|solicitor|\bSRA\b|attorney|barrister|billing/i);
    assert.ok(!leak, `${key} screen leaked legal wording: ${leak?.[0]}`);
  }

  // 3. Selector lists the backend registry and flags fixtures
  const selector = renderToStaticMarkup(
    React.createElement(SectorPackSelector, { token: "tok", sectorProfile: profileFor("LEGAL"), onChanged: () => undefined })
  );
  assert.ok(selector.includes("UK Legal Sector Pack (SRA 2023)"));
  assert.ok(selector.includes("Neutral Work-Design Core"));
  assert.ok(selector.includes("Synthetic Test Sector (test fixture, not a launched pack)"));
  assert.ok(selector.includes("Healthcare Sector Pack (Preview) (preview, pending policy review)"));
  assert.ok(selector.includes("Software &amp; IT Sector Pack (Preview) (preview, pending policy review)"));
  assert.ok(!selector.includes("UK Legal Sector Pack (SRA 2023) (preview"), "the launched pack is not flagged as preview");
  assert.ok(selector.includes("Apply Sector Pack"));
  const hidden = renderToStaticMarkup(
    React.createElement(SectorPackSelector, { token: "tok", sectorProfile: { ...profileFor("LEGAL"), availableSectors: [] }, onChanged: () => undefined })
  );
  assert.strictEqual(hidden, "", "selector renders nothing without a sector list");

  // 4. Helpers
  assert.strictEqual(getSectorUi(null), NEUTRAL_UI);
  assert.strictEqual(getSectorUi({ ...profileFor("LEGAL"), ui: undefined }), NEUTRAL_UI);
  assert.strictEqual(isSectorPackActive(null), false);
  assert.strictEqual(isSectorPackActive(profileFor("GENERIC")), false);
  assert.strictEqual(isSectorPackActive(profileFor("SYNTHETIC_TEST")), true);
  assert.strictEqual(isSectorPackActive({ ...profileFor("LEGAL"), packActive: undefined }), true, "legacy flag fallback");
  assert.strictEqual(labelFor("CORPORATE_MA", { CORPORATE_MA: "Corporate M&A" }), "Corporate M&A");
  assert.strictEqual(labelFor("WARD_3"), "Ward 3");

  // 5. Sector-neutral source: the sector screens hold no sector-specific words
  const src = (rel: string) => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", rel), "utf-8");
  const sourceBan = /legal|matter|lawyer|solicitor|\bSRA\b|partner|attorney|barrister/i;
  for (const rel of ["components/Tabs/SectorPackTab.tsx", "components/SectorPackSelector.tsx"]) {
    const m = src(rel).match(sourceBan);
    assert.ok(!m, `${rel} contains sector-specific wording: ${m?.[0]}`);
  }

  console.log("✔ Sector pack screen tests passed (legal wording preserved, new sector renders neutral, selector, helpers, source neutrality).");
}

run();
