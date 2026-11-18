// frontend/tests/components.test.tsx
// Component-level unit tests (Completion Plan Section 7.4):
// Verifies StateView renders all 9 required states safely and sector vocabulary swaps cleanly.

import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StateView, type ViewState } from "../src/components/StateView";
import { getSectorVocabulary, NEUTRAL_VOCABULARY } from "../src/utils/vocabulary";
import type { TenantSectorProfile } from "../src/api/client";

function run() {
  // 1. All 9 StateView states
  const samples: Array<{ state: ViewState; mustContain: string; mustNotContain?: string[] }> = [
    { state: { kind: "loading" }, mustContain: "Loading secure tenant data" },
    { state: { kind: "empty", reason: "No approved snapshots yet." }, mustContain: "No approved snapshots yet." },
    { state: { kind: "stale", asOf: "2026-11-18T10:00:00Z" }, mustContain: "2026-11-18T10:00:00Z" },
    { state: { kind: "partial", note: "2 connectors syncing" }, mustContain: "2 connectors syncing" },
    {
      state: { kind: "suppressed" },
      mustContain: "Not available for this selection",
      mustNotContain: ["n=", "threshold", "10", "overlap", "floor"]
    },
    { state: { kind: "unauthorized" }, mustContain: "ACCESS DENIED" },
    { state: { kind: "conflict", hint: "Reload entity" }, mustContain: "CONFLICT (409)" },
    {
      state: { kind: "failed", requestId: "req-ops-991", message: "Upstream unavailable" },
      mustContain: "req-ops-991",
      mustNotContain: ["at Object.", "Error:", ".ts:"]
    },
    { state: { kind: "ok" }, mustContain: "ok-child-content" }
  ];

  for (const tc of samples) {
    const html = renderToStaticMarkup(
      React.createElement(StateView, { state: tc.state }, React.createElement("div", null, "ok-child-content"))
    );
    assert.ok(html.includes(tc.mustContain), `StateView(${tc.state.kind}) missing expected text: ${tc.mustContain}`);
    for (const banned of tc.mustNotContain ?? []) {
      assert.ok(!html.toLowerCase().includes(banned.toLowerCase()), `StateView(${tc.state.kind}) leaked banned substring: ${banned}`);
    }
  }

  // 2. Sector vocabulary mapping & neutral fallback
  assert.deepStrictEqual(getSectorVocabulary(null), NEUTRAL_VOCABULARY);

  const genericProfile: TenantSectorProfile = {
    tenantId: "t-generic",
    sectorKey: "GENERIC",
    hasLegalPack: false,
    activePacks: ["generic-core"],
    vocabulary: { ...NEUTRAL_VOCABULARY },
    demandWindows: ["PEAK_WINDOW"],
    claimScope: "General workplace risk",
    enabledSectors: ["GENERIC", "LEGAL", "ACCOUNTING"]
  };
  const genDict = getSectorVocabulary(genericProfile);
  assert.strictEqual(genDict.workItem, "Work Item");
  assert.ok(!JSON.stringify(genDict).toLowerCase().includes("matter"));
  assert.ok(!JSON.stringify(genDict).toLowerCase().includes("partner"));

  const legalDict = getSectorVocabulary({
    ...genericProfile,
    tenantId: "t-legal",
    sectorKey: "LEGAL",
    hasLegalPack: true,
    vocabulary: {
      workItem: "Matter",
      workItems: "Matters",
      unit: "Practice Area",
      demandWindow: "Trial / Closing Window",
      supervisor: "Supervising Partner"
    }
  });
  assert.strictEqual(legalDict.workItem, "Matter");
  assert.strictEqual(legalDict.unit, "Practice Area");

  const acctDict = getSectorVocabulary({
    ...genericProfile,
    tenantId: "t-acct",
    sectorKey: "ACCOUNTING",
    vocabulary: {
      workItem: "Engagement",
      workItems: "Engagements",
      unit: "Service Line",
      demandWindow: "Filing Deadline",
      supervisor: "Engagement Partner"
    }
  });
  assert.strictEqual(acctDict.workItem, "Engagement");
  assert.strictEqual(acctDict.demandWindow, "Filing Deadline");

  console.log("✔ Frontend component unit tests passed (9 StateView states + 3 sector vocabularies).");
}

run();
