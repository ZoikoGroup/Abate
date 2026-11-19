// backend/tools/test-hold-reference.ts
// A records hold applies to every sector, so its reference is a neutral case reference.
// Verifies the new name, the deprecated alias, idempotent replay across both, and the stored view.
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { app } from "../src/index";

console.log("\x1b[36m=== Abate Task Runner: test-hold-reference (Neutral Case Reference + Deprecated Alias) ===\x1b[0m");

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

const token = createDevToken({
  tenantId: GOLDEN_01.tenantA.id,
  subject: "auth0|user-tenant-a-risk-owner",
  role: "RISK_OWNER",
  purpose: "WORKPLACE_RISK_ASSESSMENT"
});

let base = "";
async function call(method: "GET" | "POST", path: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const REASON = "Preserve work-pattern evidence for a pending review";
const placed: string[] = [];

/** Holds block retention purges and cannot be deleted, so release every hold this test places. */
async function releasePlacedHolds() {
  for (const id of placed) {
    await call("POST", `/api/v2/legal-holds/${id}/release`, { releaseReason: "Test cleanup after hold reference checks" }, `hold-ref-release-${id}`);
  }
}

async function run() {
  await seedTwoTenants();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await it("places a hold with the neutral caseRef and echoes both names", async () => {
      const r = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", caseRef: "CASE-NEUTRAL-1", reason: REASON }, "hold-ref-1");
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      placed.push(r.body.id);
      assert.strictEqual(r.body.caseRef, "CASE-NEUTRAL-1");
      assert.strictEqual(r.body.matterRef, "CASE-NEUTRAL-1", "deprecated alias echoes the same value");
    });

    await it("still accepts the deprecated matterRef", async () => {
      const r = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", matterRef: "MATTER-OLD-1", reason: REASON }, "hold-ref-2");
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      placed.push(r.body.id);
      assert.strictEqual(r.body.caseRef, "MATTER-OLD-1");
    });

    await it("rejects a body with neither name, and a body whose two names disagree", async () => {
      const none = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", reason: REASON }, "hold-ref-3");
      assert.strictEqual(none.status, 400);
      const clash = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", caseRef: "A-1", matterRef: "B-2", reason: REASON }, "hold-ref-4");
      assert.strictEqual(clash.status, 400);
      const same = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", caseRef: "SAME-1", matterRef: "SAME-1", reason: REASON }, "hold-ref-5");
      assert.strictEqual(same.status, 200, "matching names are accepted");
      placed.push(same.body.id);
    });

    await it("treats the same request under either name as one request for idempotency", async () => {
      const first = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", matterRef: "IDEM-1", reason: REASON }, "hold-ref-idem");
      assert.strictEqual(first.status, 200);
      placed.push(first.body.id);
      const replay = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", caseRef: "IDEM-1", reason: REASON }, "hold-ref-idem");
      assert.strictEqual(replay.status, 200, "replay under the other name is not a conflict");
      assert.strictEqual(replay.body.id, first.body.id, "replay returns the original hold");
      const different = await call("POST", "/api/v2/legal-holds", { dataCategory: "WORK_FACT", caseRef: "IDEM-OTHER", reason: REASON }, "hold-ref-idem");
      assert.strictEqual(different.status, 409, "a different reference under the same key is still a conflict");
    });

    await it("the retention view exposes case_ref beside the stored matter_ref", async () => {
      const r = await call("GET", "/api/v2/retention");
      assert.strictEqual(r.status, 200);
      const refs = r.body.holds.map((h: any) => h.case_ref).sort();
      assert.ok(refs.includes("CASE-NEUTRAL-1") && refs.includes("MATTER-OLD-1"));
      for (const h of r.body.holds) assert.strictEqual(h.case_ref, h.matter_ref);
    });
  } finally {
    await releasePlacedHolds();
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n\x1b[32mAll ${passed} hold reference checks passed.\x1b[0m`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
