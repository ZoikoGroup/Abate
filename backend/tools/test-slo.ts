// backend/tools/test-slo.ts
// B8 gate: drives the real HTTP app on an ephemeral port, then checks the SLO report against the
// register targets and the zero-impersonation / safe-error contract end to end.
import assert from "node:assert";
import crypto from "node:crypto";
import { AddressInfo } from "node:net";
import { app } from "../src/index";
import { GOLDEN_01 } from "../src/fixtures/golden01";

console.log("\x1b[36m=== Abate Task Runner: test-slo (B8 SLO & Support Gates) ===\x1b[0m");

const PER_CLASS = 120;
const CONCURRENCY = 8;
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function pool<T>(tasks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]!();
    }
  }));
  return out;
}

async function run() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = (path: string, init: RequestInit & { token?: string; key?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const tokenRes = await call("/api/v2/auth/token", {
    method: "POST",
    body: JSON.stringify({ tenantId: GOLDEN_01.tenantA.id, subject: "auth0|user-tenant-a-risk-owner", role: "RISK_OWNER" })
  });
  const tenantToken = (await tokenRes.json()).token as string;
  const supportToken = (await (await call("/api/v2/auth/support-token", {
    method: "POST",
    body: JSON.stringify({ operator: "ops.slo-gate" })
  })).json()).token as string;

  // Fixtures seed asynchronously on import; wait until the tenant resolves
  for (let i = 0; i < 50; i++) {
    if ((await call("/api/v2/tenants/current", { token: tenantToken })).ok) break;
    await new Promise(r => setTimeout(r, 100));
  }

  // Synthetic load across the three B8 classes
  const reads = ["/api/v2/organizations", "/api/v2/connections", "/api/v2/retention", "/api/v2/hazards", "/api/v2/receipts"];
  const tasks: Array<() => Promise<number>> = [];
  for (let i = 0; i < PER_CLASS; i++) {
    tasks.push(async () => (await call(reads[i % reads.length]!, { token: tenantToken })).status);
    tasks.push(async () => (await call("/api/v2/organizations", {
      method: "POST", token: tenantToken, key: `slo-${crypto.randomUUID()}`, body: JSON.stringify({ name: `SLO Practice ${i}` })
    })).status);
    tasks.push(async () => (await call("/api/v2/releases/query", {
      method: "POST", token: tenantToken, body: JSON.stringify({ query: { releaseClass: "CLASS_B" } })
    })).status);
  }
  const statuses = await pool(tasks, CONCURRENCY);
  const serverErrors = statuses.filter(s => s >= 500).length;

  const sloRes = await call("/api/v2/ops/slo", { token: supportToken });
  const report = await sloRes.json();

  console.log(`  Load: ${tasks.length} requests, ${serverErrors} server errors`);
  for (const l of report.latency) {
    console.log(`    ${l.routeClass.padEnd(18)} p95 ${String(l.p95Ms).padStart(7)} ms / target ${l.targetP95Ms} ms  (${l.requests} req) ${l.status}`);
  }
  console.log(`    AVAILABILITY       ${(report.availability.ratio * 100).toFixed(3)}% / target ${report.availability.target * 100}%  ${report.availability.status}`);

  await check("SLO: every class meets its register p95 target under load", async () => {
    assert.strictEqual(sloRes.status, 200);
    for (const l of report.latency) {
      assert.ok(l.requests >= PER_CLASS, `${l.routeClass} must have been exercised`);
      assert.strictEqual(l.status, "MET", `${l.routeClass} p95 ${l.p95Ms}ms exceeds ${l.targetP95Ms}ms`);
    }
  });

  await check("SLO: availability meets 99.9% with no server errors in the window", async () => {
    assert.strictEqual(serverErrors, 0);
    assert.strictEqual(report.availability.status, "MET");
    assert.strictEqual(report.overall, "MET");
  });

  await check("Zero impersonation: support token is refused on tenant routes; tenant token is refused on ops routes", async () => {
    assert.strictEqual((await call("/api/v2/organizations", { token: supportToken })).status, 401);
    assert.strictEqual((await call("/api/v2/support/diagnostic-receipts", { method: "POST", token: supportToken, key: crypto.randomUUID() })).status, 401);
    assert.strictEqual((await call("/api/v2/ops/slo", { token: tenantToken })).status, 401);
    assert.strictEqual((await call("/api/v2/ops/requests/x", { token: tenantToken })).status, 401);
    assert.strictEqual((await call("/api/v2/ops/slo")).status, 401);
  });

  await check("Support correlation: a reported requestId resolves to a content-free record (route template, no ids)", async () => {
    const missingId = crypto.randomUUID();
    const failed = await call(`/api/v2/organizations/${missingId}`, { token: tenantToken });
    const body = await failed.json();
    assert.strictEqual(failed.status, 404);
    assert.strictEqual(body.requestId, failed.headers.get("x-request-id"), "Error body and header must carry the same id");

    const lookup = await call(`/api/v2/ops/requests/${body.requestId}`, { token: supportToken });
    const record = await lookup.json();
    assert.strictEqual(lookup.status, 200);
    assert.strictEqual(record.route, "/api/v2/organizations/:id");
    assert.strictEqual(record.errorCode, "NOT_FOUND");
    const dump = JSON.stringify(record);
    for (const secret of [missingId, GOLDEN_01.tenantA.id, "auth0|user-tenant-a-risk-owner", tenantToken]) {
      assert.ok(!dump.includes(secret), "Ops record must not contain raw ids, tenant, subject or credentials");
    }
  });

  await check("Safe errors: malformed JSON gets the JSON error envelope, never an HTML stack page", async () => {
    const bad = await fetch(`${base}/api/v2/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tenantToken}`, "idempotency-key": "k" },
      body: "{ not json"
    });
    const text = await bad.text();
    assert.strictEqual(bad.status, 400);
    assert.ok(!/<html|at .*\(.*:\d+:\d+\)/i.test(text), "No HTML or stack frames in error responses");
    assert.strictEqual(JSON.parse(text).code, "VALIDATION");
  });

  await check("Signed diagnostics: tenant-issued receipt verifies for support; an edited copy does not", async () => {
    const issued = await (await call("/api/v2/support/diagnostic-receipts", { method: "POST", token: tenantToken, key: crypto.randomUUID() })).json();
    const verify = async (receipt: unknown) =>
      (await (await call("/api/v2/ops/diagnostic-receipts/verify", { method: "POST", token: supportToken, body: JSON.stringify(receipt) })).json()).valid;
    assert.strictEqual(await verify(issued), true);
    assert.strictEqual(await verify({ ...issued, generatedAt: new Date(0).toISOString() }), false);
  });

  server.close();
  console.log(`\x1b[32m[SUCCESS] All ${passed} SLO and support gates passed.\x1b[0m`);
  process.exit(0);
}

run().catch(err => {
  console.error("\x1b[31m[SLO GATE FAILED]\x1b[0m", err);
  process.exit(1);
});
