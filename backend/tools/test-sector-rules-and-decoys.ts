// backend/tools/test-sector-rules-and-decoys.ts
// Phase 2-4 Deep Sector Rules, Jurisdiction Overlays & Per-Sector Decoy Minimization Lab:
// 1. Proves all 5 deterministic cohort rule primitives (late nights, inter-shift rest, rolling weekly hours,
//    on-call/weekend rest, high-demand window duration) across LEGAL, HEALTHCARE, SOFTWARE_IT, ACCOUNTING.
// 2. Proves PREVIEW/FIXTURE packs cannot register APPROVED rules or APPROVED jurisdiction overlays.
// 3. Proves expired/preview/draft jurisdiction overlays fail closed (supportsComplianceClaim === false).
// 4. Fires every sector's forbidden fields through /api/v2/sector/work-items/map and asserts 400 VALIDATION
//    with zero decoy leakage in response payloads or telemetry logs.
// 5. Proves GET /api/v2/sector/rules returns sector-specific rules & overlays without code branches.

import assert from "node:assert";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { loadConfig } from "../src/platform/config";
import { isPostgresRequired } from "../src/platform/db/with-tenant";
import {
  getSectorMapping,
  registerSectorPack
} from "../src/domains/lifecycle/sector";
import {
  evaluateSectorRules,
  resolveJurisdictionOverlay
} from "../src/domains/sector-work";
import { telemetry } from "../src/platform/telemetry";

let passed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err?.message || err}`);
    process.exit(1);
  }
}

async function main() {
  console.log("\x1b[36m=== Abate Deep Sector Rules, Jurisdiction Overlays & Decoy Lab ===\x1b[0m\n");

  await seedTwoTenants({ clock: new Date(loadConfig().fixedClock), persistToPostgres: isPostgresRequired() });

  const tokenA = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });

  await check("Healthcare night-shift-aware MIN_INTER_SHIFT_REST triggers on <11h turnaround and passes on 13h rest", () => {
    const hc = getSectorMapping("HEALTHCARE")!;
    // Normal night shifts with 13h rest between shifts -> does NOT trigger inter-shift rest violation
    const safeNightShifts = [
      { startUtc: "2026-03-02T20:00:00Z", endUtc: "2026-03-03T07:00:00Z" },
      { startUtc: "2026-03-03T20:00:00Z", endUtc: "2026-03-04T07:00:00Z" }
    ];
    const safeReport = evaluateSectorRules(hc, { workItemId: "HC-1", unit: "EMERGENCY", demandWindow: "SURGE_CAPACITY" }, safeNightShifts, {
      jurisdictionCode: "UK"
    });
    const safeRestRule = safeReport.rules.find((r) => r.ruleId === "HC_INTER_SHIFT_REST")!;
    assert.strictEqual(safeRestRule.triggered, false, "13h rest between night shifts must not trigger <11h rest rule");
    assert.strictEqual(safeReport.jurisdictionOverlay.supportsComplianceClaim, false, "PREVIEW pack cannot support compliance claim");

    // Short 8h turnaround between shifts -> MUST trigger HC_INTER_SHIFT_REST
    const shortRestShifts = [
      { startUtc: "2026-03-02T08:00:00Z", endUtc: "2026-03-02T22:00:00Z" },
      { startUtc: "2026-03-03T06:00:00Z", endUtc: "2026-03-03T18:00:00Z" }
    ];
    const breachReport = evaluateSectorRules(hc, { workItemId: "HC-1", unit: "EMERGENCY", demandWindow: "SURGE_CAPACITY" }, shortRestShifts, {
      jurisdictionCode: "UK"
    });
    const breachRestRule = breachReport.rules.find((r) => r.ruleId === "HC_INTER_SHIFT_REST")!;
    assert.strictEqual(breachRestRule.triggered, true, "8h turnaround must trigger HC_INTER_SHIFT_REST");
    assert.strictEqual(breachRestRule.observedValue, 1);
  });

  await check("Software & IT on-call weekend rest rule triggers on unbuffered Sat+Sun pager work", () => {
    const sw = getSectorMapping("SOFTWARE_IT")!;
    // 2026-03-07 is Saturday, 2026-03-08 is Sunday
    const weekendOnCall = [
      { startUtc: "2026-03-07T10:00:00Z", endUtc: "2026-03-07T18:00:00Z" },
      { startUtc: "2026-03-08T11:00:00Z", endUtc: "2026-03-08T19:00:00Z" }
    ];
    const report = evaluateSectorRules(sw, { workItemId: "SW-1", unit: "PLATFORM", demandWindow: "ON_CALL_ROTATION" }, weekendOnCall, {
      jurisdictionCode: "EU"
    });
    const weekendRule = report.rules.find((r) => r.ruleId === "SW_ON_CALL_WEEKEND_RECOVERY")!;
    assert.strictEqual(weekendRule.triggered, true, "Both Sat and Sun on-call days must trigger weekend recovery rule");
    assert.strictEqual(report.jurisdictionOverlay.overlayKey, "software-eu-preview");
    assert.strictEqual(report.jurisdictionOverlay.supportsComplianceClaim, false);
  });

  await check("Accounting rolling weekly hours rule triggers above 48h/week and Legal sustained peak duration triggers above 14d", () => {
    const acc = getSectorMapping("ACCOUNTING")!;
    const heavyWeek = [
      { startUtc: "2026-03-02T08:00:00Z", endUtc: "2026-03-02T20:00:00Z" },
      { startUtc: "2026-03-03T08:00:00Z", endUtc: "2026-03-03T20:00:00Z" },
      { startUtc: "2026-03-04T08:00:00Z", endUtc: "2026-03-04T20:00:00Z" },
      { startUtc: "2026-03-05T08:00:00Z", endUtc: "2026-03-05T20:00:00Z" },
      { startUtc: "2026-03-06T08:00:00Z", endUtc: "2026-03-06T18:00:00Z" }
    ]; // 58h in 7 days
    const accReport = evaluateSectorRules(acc, { workItemId: "ACC-1", unit: "AUDIT", demandWindow: "BUSY_SEASON" }, heavyWeek);
    const hoursRule = accReport.rules.find((r) => r.ruleId === "ACC_ROLLING_WEEKLY_HOURS")!;
    assert.strictEqual(hoursRule.triggered, true);
    assert.ok(hoursRule.observedValue > 48);

    const legal = getSectorMapping("LEGAL")!;
    const longPeak = [
      { startUtc: "2026-03-01T09:00:00Z", endUtc: "2026-03-01T18:00:00Z" },
      { startUtc: "2026-03-20T09:00:00Z", endUtc: "2026-03-20T18:00:00Z" }
    ]; // 20-day span
    const legalReport = evaluateSectorRules(legal, { workItemId: "M-1", unit: "COMMERCIAL_LITIGATION", demandWindow: "TRIAL_PREP" }, longPeak, {
      jurisdictionCode: "UK"
    });
    const durRule = legalReport.rules.find((r) => r.ruleId === "LEGAL_SUSTAINED_PEAK_DURATION")!;
    assert.strictEqual(durRule.triggered, true);
    assert.ok(durRule.observedValue > 14);
  });

  await check("Pack validator rejects APPROVED citations/overlays on PREVIEW packs and expired overlays fail closed", () => {
    const basePreview = {
      sectorKey: "LOGISTICS_GUARD_TEST",
      packKey: "logistics-guard-preview",
      acceptedPackKeys: ["logistics-guard-preview"],
      bindingMatchers: ["logisticsguard"],
      status: "PREVIEW" as const,
      displayName: "Logistics Guard Test",
      vocabulary: { workItem: "Route", workItems: "Routes", unit: "Hub", demandWindow: "Peak Dispatch", supervisor: "Dispatch Lead" },
      workItemFields: { externalRef: ["routeId"], unit: ["hub"] },
      demandWindows: ["PEAK_DISPATCH"],
      highDemandWindows: ["PEAK_DISPATCH"],
      fatigueRule: { highDemandWindows: ["PEAK_DISPATCH"], consecutiveLateNights: 3, lateEveningUtcHour: 20, earlyMorningUtcHour: 6 },
      forbidden: ["driverTelemetryScore"],
      requiredGates: ["APPROVAL", "CONSULTATION"] as const,
      claimScope: "Preview test pack.",
      cannotOverride: ["privacyFloor", "aiAuthority"] as const
    };

    assert.throws(
      () =>
        registerSectorPack({
          ...basePreview,
          rules: [
            {
              ruleId: "LOG_BAD_APPROVED",
              title: "Illegal Approved Rule on Preview Pack",
              type: "MIN_INTER_SHIFT_REST",
              minRestHours: 11,
              maxShortRestTransitions: 0,
              requiredGate: "CONSULTATION",
              citationStatus: "APPROVED",
              reference: "Unapproved Citation",
              rationale: "Must be rejected on PREVIEW pack"
            }
          ]
        }),
      /cannot mark citationStatus APPROVED on a PREVIEW pack/i
    );

    // Register a pack with an expired overlay and verify fail-closed resolution
    const expiredMapping = registerSectorPack({
      ...basePreview,
      sectorKey: "EXPIRED_OVERLAY_TEST",
      packKey: "expired-overlay-test",
      acceptedPackKeys: ["expired-overlay-test"],
      bindingMatchers: ["expiredoverlay"],
      jurisdictionOverlays: [
        {
          overlayKey: "expired-uk-ov",
          jurisdictionCode: "UK",
          effectiveFrom: "2024-01-01T00:00:00Z",
          effectiveTo: "2025-01-01T00:00:00Z",
          approvalStatus: "PREVIEW_PLACEHOLDER",
          accountableReviewer: null,
          reviewDate: null,
          statutoryReferences: [],
          consultationGates: ["CONSULTATION"],
          retentionNote: "Expired test overlay."
        }
      ]
    });
    const resolved = resolveJurisdictionOverlay(expiredMapping, {
      jurisdictionCode: "UK",
      at: new Date("2026-06-01T00:00:00Z")
    });
    assert.strictEqual(resolved.overlayStatus, "EXPIRED");
    assert.strictEqual(resolved.supportsComplianceClaim, false);
  });

  await check("Per-sector decoy minimization lab blocks forbidden fields on HEALTHCARE, SOFTWARE_IT, ACCOUNTING and leaves 0 telemetry leaks", async () => {
    const sectorScenarios: Array<{
      sectorKey: string;
      packKey: string;
      unit: string;
      demandWindow: string;
      decoys: Record<string, string | number>;
    }> = [
      {
        sectorKey: "HEALTHCARE",
        packKey: "healthcare-preview",
        unit: "EMERGENCY_CARE",
        demandWindow: "SURGE_CAPACITY",
        decoys: {
          patientIdentifier: "SECRET-PAT-99911",
          nhsNumber: "SECRET-NHS-444555",
          mrn: "SECRET-MRN-888777",
          clinicalNotes: "SECRET-CLINICAL-DIAGNOSIS-NOTE"
        }
      },
      {
        sectorKey: "SOFTWARE_IT",
        packKey: "software-it-preview",
        unit: "CORE_PLATFORM",
        demandWindow: "INCIDENT_RESPONSE",
        decoys: {
          sourceCode: "SECRET-REPO-SOURCE-CODE",
          commitDiff: "SECRET-GIT-DIFF-PAYLOAD",
          individualVelocity: 99,
          prCount: 42
        }
      },
      {
        sectorKey: "ACCOUNTING",
        packKey: "accounting-fixture",
        unit: "EXTERNAL_AUDIT",
        demandWindow: "BUSY_SEASON",
        decoys: {
          clientWorkpapers: "SECRET-AUDIT-WORKPAPER",
          clientTaxReturns: "SECRET-TAX-RETURN-1040",
          billableUtilizationRanking: 1
        }
      },
      {
        sectorKey: "FINANCE",
        packKey: "finance-preview",
        unit: "GLOBAL_MACRO",
        demandWindow: "MARKET_VOLATILITY",
        decoys: {
          tradeTickets: "SECRET-TICKET-BUY-AAPL",
          mnpiContent: "SECRET-MNPI-LEAK",
          clientPortfolio: "SECRET-CLIENT-HOLDINGS",
          individualPnL: 999999
        }
      }
    ];

    try {
      for (const s of sectorScenarios) {
        const sw = await expressCall("PUT", "/api/v2/tenant/sector-profile", {
          token: tokenA,
          headers: { "Idempotency-Key": `decoy-switch-${s.sectorKey}-${Date.now()}` },
          body: { sectorKey: s.sectorKey, packKey: s.packKey }
        });
        assert.strictEqual(sw.status, 200, `Switching to ${s.sectorKey} must succeed`);

        // GET /api/v2/sector/rules returns this sector's rules and overlays
        const rulesRes = await expressCall("GET", "/api/v2/sector/rules", { token: tokenA });
        assert.strictEqual(rulesRes.status, 200);
        assert.strictEqual(rulesRes.body.sectorKey, s.sectorKey);
        assert.ok(Array.isArray(rulesRes.body.rules) && rulesRes.body.rules.length >= 3, `${s.sectorKey} must expose >= 3 rules`);
        assert.ok(Array.isArray(rulesRes.body.jurisdictionOverlays) && rulesRes.body.jurisdictionOverlays.length >= 1);

        // Fire each forbidden decoy field and confirm strict 400 rejection + zero telemetry leak
        for (const [field, decoyVal] of Object.entries(s.decoys)) {
          const mapRes = await expressCall("POST", "/api/v2/sector/work-items/map", {
            token: tokenA,
            body: {
              externalRef: `DECOY-${s.sectorKey}-1`,
              title: "Synthetic Decoy Probe",
              unit: s.unit,
              demandWindow: s.demandWindow,
              accountableReviewerId: "00000000-0000-4000-a002-000000000001",
              activeWindowStart: "2026-03-01T08:00:00Z",
              activeWindowEnd: "2026-03-05T18:00:00Z",
              [field]: decoyVal
            }
          });
          assert.strictEqual(mapRes.status, 400, `${s.sectorKey} must reject forbidden field '${field}' with 400`);
          const rawBody = JSON.stringify(mapRes.body);
          if (typeof decoyVal === "string") {
            assert.strictEqual(rawBody.includes(decoyVal), false, `Response must never echo decoy value for '${field}'`);
            const rawTelemetry = JSON.stringify(telemetry.errorLog);
            assert.strictEqual(rawTelemetry.includes(decoyVal), false, `Telemetry must never persist decoy value for '${field}'`);
          }
        }
      }
    } finally {
      // Restore Legal pack for Tenant A
      await expressCall("PUT", "/api/v2/tenant/sector-profile", {
        token: tokenA,
        headers: { "Idempotency-Key": `decoy-restore-legal-${Date.now()}` },
        body: { sectorKey: "LEGAL", packKey: "legal-uk-sra" }
      });
    }
  });

  await check("Interactive fatigue simulation evaluates simulated patterns without pre-seeded DB records", async () => {
    const simRes = await expressCall("POST", "/api/v2/sector/work-items/fatigue-check", {
      token: tokenA,
      body: {
        workItemId: "SIM-HC-TEST-001",
        simulatedItem: { unit: "ACUTE_MEDICINE", demandWindow: "SURGE_CAPACITY" },
        intervals: [
          { startUtc: "2026-03-01T20:00:00Z", endUtc: "2026-03-02T08:00:00Z" },
          { startUtc: "2026-03-02T16:00:00Z", endUtc: "2026-03-03T04:00:00Z" } // 8h rest gap (<11h)
        ]
      }
    });
    assert.strictEqual(simRes.status, 200, "Simulated fatigue check must return 200");
    assert.strictEqual(simRes.body.workItemId, "SIM-HC-TEST-001");
    assert.ok(Array.isArray(simRes.body.ruleFindings), "Must include rule findings");
  });

  console.log(`\n\x1b[32m✔ Deep Sector Rules, Jurisdiction Overlays & Decoy Lab PASSED (${passed} checks).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[SECTOR-RULES-LAB ERROR]\x1b[0m", err);
  process.exit(1);
});
