// backend/tools/test-sector-work.ts
// HTTP-level checks for the sector work-item endpoints:
//  - generic /api/v2/sector/work-items/* is driven by the tenant's active sector pack
//  - legal-named /api/v2/sector/legal/* aliases keep their shapes and stay legal-only
//  - a newly registered sector works through the same routes with no route changes
import assert from "node:assert";
process.env.ABATE_ALLOW_PREVIEW_PACK_TESTS = "1";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { SEEDED_WORK_ITEMS } from "../src/fixtures/sector-work-items";
import { createDevToken } from "../src/domains/tenant/auth";
import { registerSectorPack, setTenantSectorSetting } from "../src/domains/lifecycle/sector";
import { withTenant } from "../src/platform/db/with-tenant";
import { expressCall } from "./simulate-30d-http";

console.log("\x1b[36m=== Abate Task Runner: test-sector-work (Generic Sector Endpoints + Legal Aliases) ===\x1b[0m");

let passed = 0;
async function it(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

const tenantA = GOLDEN_01.tenantA.id;
const tenantB = GOLDEN_01.tenantB.id;
const tokenA = createDevToken({ tenantId: tenantA, subject: "auth0|user-tenant-a-risk-owner", role: "RISK_OWNER", purpose: "WORKPLACE_RISK_ASSESSMENT" });
const tokenB = createDevToken({ tenantId: tenantB, subject: "auth0|user-tenant-b-risk-owner", role: "RISK_OWNER", purpose: "WORKPLACE_RISK_ASSESSMENT" });

let keySeq = 0;
async function call(method: "GET" | "POST" | "PUT", path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (method === "PUT") headers["idempotency-key"] = `sector-work-test-${++keySeq}`;
  const res = await expressCall(method, path, {
    token,
    body,
    headers
  });
  return { status: res.status, body: res.body };
}

const legalItem = {
  externalRef: "MAT-TEST-1",
  title: "Synthetic Test Matter",
  unit: "ARBITRATION",
  demandWindow: "TRIAL_PREP",
  jurisdiction: "LCIA_ARBITRATION",
  accountableReviewerId: "00000000-0000-4000-a000-000000000001",
  activeWindowStart: "2026-03-01T08:00:00Z",
  activeWindowEnd: "2026-03-20T18:00:00Z"
};

// A persistent database keeps tenant sector settings between runs, so start and finish on the legal packs.
async function resetSectors() {
  await withTenant(tenantA, (tx) => setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "LEGAL", packKey: "legal-uk-sra" }));
  await withTenant(tenantB, (tx) => setTenantSectorSetting(tx, { tenantId: tenantB, sectorKey: "LEGAL", packKey: "legal-uk-bar" }));
}

async function run() {
  await seedTwoTenants();
  await resetSectors();

  try {
    await it("generic list returns the tenant's legal items with vocabulary, and no other tenant's", async () => {
      const a = await call("GET", "/api/v2/sector/work-items", tokenA);
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.body.sectorKey, "LEGAL");
      assert.strictEqual(a.body.vocabulary.workItem, "Matter");
      assert.deepStrictEqual(a.body.items.map((i: any) => i.externalRef).sort(), ["MAT-2026-LON-001", "MAT-2026-LON-002"]);
      const b = await call("GET", "/api/v2/sector/work-items", tokenB);
      assert.deepStrictEqual(b.body.items.map((i: any) => i.externalRef), ["MAT-2026-ARB-009"]);
    });

    await it("legal alias list keeps its original shape and matches the generic list", async () => {
      const legal = await call("GET", "/api/v2/sector/legal/matters", tokenA);
      assert.strictEqual(legal.status, 200);
      const m = legal.body.items.find((x: any) => x.matterId === "MAT-2026-LON-001");
      assert.ok(m, "matter present");
      assert.strictEqual(m.matterTitle, "High Court Commercial Injunction Proceedings");
      assert.strictEqual(m.practiceArea, "COMMERCIAL_LITIGATION");
      assert.strictEqual(m.currentPhase, "TRIAL_PREP");
      assert.strictEqual(m.leadPartnerId, "00000000-0000-4000-a000-000000000001");
      const generic = await call("GET", "/api/v2/sector/work-items", tokenA);
      assert.strictEqual(legal.body.items.length, generic.body.items.length);
    });

    await it("generic map validates against the pack and returns the neutral work item", async () => {
      const r = await call("POST", "/api/v2/sector/work-items/map", tokenA, legalItem);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.complianceStatus, "VALIDATED");
      assert.strictEqual(r.body.neutralWorkItem.kind, "WORK_ITEM");
      assert.strictEqual(r.body.neutralWorkItem.externalRef, "MAT-TEST-1");
      assert.strictEqual(r.body.sectorPack, "legal-uk-sra");
    });

    await it("generic map rejects pack-forbidden fields with the constitutional message", async () => {
      for (const f of ["billingRate", "privilegedAdvice", "individualScore", "clientConfidentialNotes", "keystrokeLogs"]) {
        const r = await call("POST", "/api/v2/sector/work-items/map", tokenA, { ...legalItem, [f]: "x" });
        assert.strictEqual(r.status, 400, `${f} should be rejected`);
        assert.match(JSON.stringify(r.body), /Constitutional Boundary Violation/);
      }
    });

    await it("generic map rejects units, windows and jurisdictions outside the pack, and unknown fields", async () => {
      for (const bad of [
        { unit: "NOT_A_PRACTICE_AREA" },
        { demandWindow: "BUSY_SEASON" },
        { jurisdiction: "MARS" },
        { activeWindowEnd: "2026-02-01T00:00:00Z" },
        { surprise: true }
      ]) {
        const r = await call("POST", "/api/v2/sector/work-items/map", tokenA, { ...legalItem, ...bad });
        assert.strictEqual(r.status, 400, `${JSON.stringify(bad)} should be rejected`);
      }
    });

    await it("generic fatigue-check uses the pack rule and legal wording", async () => {
      const r = await call("POST", "/api/v2/sector/work-items/fatigue-check", tokenA, { workItemId: "MAT-2026-LON-001" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.sectorKey, "LEGAL");
      assert.strictEqual(r.body.hasFatigueSurge, true);
      assert.strictEqual(r.body.applicableGate, "SUPERVISORY_PARTNER_CONSULTATION");
      assert.ok(r.body.statutoryReference.includes("SRA Workplace Culture Guidance 2023 §3.2"));
      const missing = await call("POST", "/api/v2/sector/work-items/fatigue-check", tokenA, { workItemId: "NOPE" });
      assert.strictEqual(missing.status, 404);
    });

    await it("legal aliases give the same fatigue result and still defend the boundary", async () => {
      const r = await call("POST", "/api/v2/sector/legal/fatigue-check", tokenA, { matterId: "MAT-2026-LON-001" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.matterId, "MAT-2026-LON-001");
      assert.strictEqual(r.body.practiceArea, "COMMERCIAL_LITIGATION");
      assert.strictEqual(r.body.applicableGate, "SUPERVISORY_PARTNER_CONSULTATION");
      const calm = await call("POST", "/api/v2/sector/legal/fatigue-check", tokenA, {
        matterId: "MAT-2026-LON-001",
        intervals: [{ startUtc: "2026-03-02T09:00:00Z", endUtc: "2026-03-02T17:00:00Z" }]
      });
      assert.strictEqual(calm.body.hasFatigueSurge, false);
      assert.strictEqual(calm.body.applicableGate, "STANDARD_APPROVAL");
      const legalPayload = {
        matterId: "MAT-X", matterTitle: "T", practiceArea: "ARBITRATION", currentPhase: "TRIAL",
        jurisdiction: "EWHC", leadPartnerId: "00000000-0000-4000-a000-000000000001",
        activeWindowStart: "2026-03-01T08:00:00Z", activeWindowEnd: "2026-03-02T08:00:00Z"
      };
      const ok = await call("POST", "/api/v2/sector/legal/matters/map", tokenA, legalPayload);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.sectorPack, "sector-legal@v1");
      const decoy = await call("POST", "/api/v2/sector/legal/matters/map", tokenA, { ...legalPayload, billingRate: 650 });
      assert.strictEqual(decoy.status, 400);
      assert.match(JSON.stringify(decoy.body), /Constitutional Boundary Violation/);
    });

    // A synthetic sector, registered at runtime, proves routes need no change for a new sector.
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
    const synthItem = {
      externalRef: "CASE-1", title: "Synthetic case", unit: "WARD_3", demandWindow: "SURGE",
      accountableReviewerId: "00000000-0000-4000-b000-000000000001",
      activeWindowStart: "2026-03-01T08:00:00Z", activeWindowEnd: "2026-03-10T08:00:00Z"
    };
    SEEDED_WORK_ITEMS[tenantB] = [...(SEEDED_WORK_ITEMS[tenantB] ?? []), { sectorKey: "SYNTHETIC_TEST", item: synthItem }];

    await it("a tenant can switch to a newly registered sector over the existing PUT endpoint", async () => {
      const put = await call("PUT", "/api/v2/tenant/sector-profile", tokenB, { sectorKey: "SYNTHETIC_TEST", packKey: "synthetic-test-pack" });
      assert.strictEqual(put.status, 200, JSON.stringify(put.body));
      assert.strictEqual(put.body.sectorKey, "SYNTHETIC_TEST");
      assert.strictEqual(put.body.vocabulary.workItem, "Case");
      const bad = await call("PUT", "/api/v2/tenant/sector-profile", tokenB, { sectorKey: "NO_SUCH_SECTOR", packKey: "x-pack" });
      assert.strictEqual(bad.status, 400);
    });

    await it("generic endpoints serve the new sector with its own windows, forbidden fields and default wording", async () => {
      const list = await call("GET", "/api/v2/sector/work-items", tokenB);
      assert.strictEqual(list.status, 200);
      assert.deepStrictEqual(list.body.items.map((i: any) => i.externalRef), ["CASE-1"]);
      const ok = await call("POST", "/api/v2/sector/work-items/map", tokenB, synthItem);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.sectorPack, "synthetic-test-pack");
      const legalWindow = await call("POST", "/api/v2/sector/work-items/map", tokenB, { ...synthItem, demandWindow: "TRIAL_PREP" });
      assert.strictEqual(legalWindow.status, 400);
      const forbidden = await call("POST", "/api/v2/sector/work-items/map", tokenB, { ...synthItem, patientIdentifier: "p-1" });
      assert.strictEqual(forbidden.status, 400);
      assert.match(JSON.stringify(forbidden.body), /patientIdentifier/);
      const fat = await call("POST", "/api/v2/sector/work-items/fatigue-check", tokenB, { workItemId: "CASE-1" });
      assert.strictEqual(fat.status, 200);
      assert.strictEqual(fat.body.hasFatigueSurge, true);
      assert.strictEqual(fat.body.applicableGate, "CONSULTATION");
      assert.ok(fat.body.regulatoryNotice.includes("Charge Lead"));
      assert.ok(!/SRA/.test(fat.body.statutoryReference), "no legal citation leaks into another sector");
    });

    await it("legal aliases fail closed for a tenant whose sector is not legal", async () => {
      for (const [method, path, body] of [
        ["GET", "/api/v2/sector/legal/matters", undefined],
        ["POST", "/api/v2/sector/legal/matters/map", legalItem],
        ["POST", "/api/v2/sector/legal/fatigue-check", { matterId: "MAT-2026-ARB-009" }]
      ] as const) {
        const r = await call(method, path, tokenB, body);
        assert.strictEqual(r.status, 403, `${path} should be 403`);
      }
    });

    await it("preview sectors work through the same routes with their own windows, forbidden fields and wording", async () => {
      const cases = [
        {
          sectorKey: "HEALTHCARE", packKey: "healthcare-preview", ref: "EPI-DEMO-001", role: "Clinical Lead",
          item: { externalRef: "EPI-NEW", title: "Synthetic episode", unit: "ACUTE_MEDICINE", demandWindow: "SURGE_CAPACITY" },
          forbidden: ["patientIdentifier", "clinicalNotes", "individualClinicianRanking"], foreignWindow: "TRIAL_PREP"
        },
        {
          sectorKey: "SOFTWARE_IT", packKey: "software-it-preview", ref: "DEL-DEMO-001", role: "Engineering Manager",
          item: { externalRef: "DEL-NEW", title: "Synthetic delivery", unit: "PLATFORM_SQUAD", demandWindow: "INCIDENT_RESPONSE" },
          forbidden: ["sourceCode", "individualVelocity", "individualCommitCount"], foreignWindow: "SURGE_CAPACITY"
        }
      ];
      for (const c of cases) {
        const put = await call("PUT", "/api/v2/tenant/sector-profile", tokenA, { sectorKey: c.sectorKey, packKey: c.packKey });
        assert.strictEqual(put.status, 200, JSON.stringify(put.body));
        assert.strictEqual(put.body.sectorKey, c.sectorKey);
        assert.ok(put.body.claimScope.includes("pending Legal & Policy Lead review"));
        assert.ok(!put.body.enabledSectors.includes(c.sectorKey), "a preview pack is never reported as enabled");

        const list = await call("GET", "/api/v2/sector/work-items", tokenA);
        assert.strictEqual(list.status, 200);
        assert.deepStrictEqual(list.body.items.map((i: any) => i.externalRef), [c.ref]);

        const full = {
          ...c.item,
          accountableReviewerId: "00000000-0000-4000-a000-000000000001",
          activeWindowStart: "2026-03-01T08:00:00Z", activeWindowEnd: "2026-03-10T08:00:00Z"
        };
        assert.strictEqual((await call("POST", "/api/v2/sector/work-items/map", tokenA, full)).status, 200);
        assert.strictEqual((await call("POST", "/api/v2/sector/work-items/map", tokenA, { ...full, demandWindow: c.foreignWindow })).status, 400);
        for (const f of [...c.forbidden, "individualScore", "keystrokeLogs"]) {
          const r = await call("POST", "/api/v2/sector/work-items/map", tokenA, { ...full, [f]: "x" });
          assert.strictEqual(r.status, 400, `${c.sectorKey} must reject ${f}`);
          assert.match(JSON.stringify(r.body), /Constitutional Boundary Violation/);
        }

        const fat = await call("POST", "/api/v2/sector/work-items/fatigue-check", tokenA, { workItemId: c.ref });
        assert.strictEqual(fat.status, 200);
        assert.strictEqual(fat.body.hasFatigueSurge, true);
        assert.ok(fat.body.regulatoryNotice.includes(c.role), "wording names the pack's own reviewer");
        assert.ok(!/SRA|solicitor|lawyer|legal/i.test(JSON.stringify(fat.body)), "no legal wording in another sector");

        // Legal aliases stay closed to non-legal sectors.
        assert.strictEqual((await call("GET", "/api/v2/sector/legal/matters", tokenA)).status, 403);
      }
    });

    await it("generic endpoints fail closed once a tenant is on the neutral baseline", async () => {
      const put = await call("PUT", "/api/v2/tenant/sector-profile", tokenA, { sectorKey: "GENERIC", packKey: "generic-work-design" });
      assert.strictEqual(put.status, 200);
      for (const [method, path, body] of [
        ["GET", "/api/v2/sector/work-items", undefined],
        ["POST", "/api/v2/sector/work-items/map", legalItem],
        ["POST", "/api/v2/sector/work-items/fatigue-check", { workItemId: "MAT-2026-LON-001" }]
      ] as const) {
        const r = await call(method, path, tokenA, body);
        assert.strictEqual(r.status, 403, `${path} should be 403`);
      }
    });
  } finally {
    await resetSectors();
  }

  console.log(`\n\x1b[32mAll ${passed} sector work endpoint checks passed.\x1b[0m`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
