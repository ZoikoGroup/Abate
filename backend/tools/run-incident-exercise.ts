// backend/tools/run-incident-exercise.ts
// Completion Plan Section 10.4 / T-28:
// Executes a live timed incident exercise:
//   1. Detect prohibited decoy & anomaly -> T_detect
//   2. Assign lead & contain smallest unsafe scope with kill switch (connector:zoikotime) -> T_contain
//   3. Preserve safe evidence (verify 0 decoy leakage in telemetry, error logs, receipts)
//   4. Verify unaffected tenant paths stay 200 OK during containment
//   5. Recover (lift kill switch) and pass post-recovery smoke tests -> T_recover
// Writes evidence/incident-exercise-report.json.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { createSupportToken } from "../src/domains/support";
import { telemetry } from "../src/platform/telemetry";

async function main() {
  console.log("\x1b[36m=== Abate Live Incident Exercise (Completion Plan §10.4 / T-28) ===\x1b[0m\n");
  await seedTwoTenants();

  const tenantToken = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });
  const supportToken = createSupportToken({ operator: "incident.lead.sre" });

  const exerciseStartMs = Date.now();
  const decoyCanary = `INCIDENT_DECOY_SCREENSHOT_${crypto.randomUUID().slice(0, 8)}`;

  // Step 1: Detect — connector transmits prohibited surveillance field
  const conns = await expressCall("GET", "/api/v2/connections", { token: tenantToken });
  assert.strictEqual(conns.status, 200);
  const zoikoConn = conns.body.find((c: any) => c.source === "ZoikoTime");
  assert.ok(zoikoConn, "ZoikoTime connection must exist");

  const decoyRes = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
    token: tenantToken,
    headers: { "idempotency-key": `inc-decoy-${crypto.randomUUID()}` },
    body: {
      connectionId: zoikoConn.id,
      batchId: `inc-decoy-${crypto.randomUUID()}`,
      screenshot_blob: decoyCanary,
      items: []
    }
  });
  assert.strictEqual(decoyRes.status, 400, "Prohibited decoy payload must fail closed with 400");
  const detectedAtMs = Date.now();

  // Step 2: Contain — incident lead activates smallest scope kill switch (connector:zoikotime)
  const activateRes = await expressCall("POST", "/api/v2/ops/kill-switches", {
    token: supportToken,
    body: {
      scope: "connector:zoikotime",
      active: true
    }
  });
  assert.strictEqual(activateRes.status, 200);
  const containedAtMs = Date.now();

  try {
    // Step 3: Verify containment blocks affected path (503) while unaffected path stays healthy (200)
    const blockedIngest = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
      token: tenantToken,
      headers: { "idempotency-key": `inc-blocked-${crypto.randomUUID()}` },
      body: {
        connectionId: zoikoConn.id,
        batchId: `inc-blocked-${crypto.randomUUID()}`,
        items: [
          {
            recordId: "inc-rec-1",
            revision: 1,
            subjectRef: "emp-inc-1",
            startUtc: "2026-03-03T09:00:00Z",
            endUtc: "2026-03-03T10:00:00Z",
            workTz: "Europe/London",
            kind: "WORK"
          }
        ]
      }
    });
    assert.strictEqual(blockedIngest.status, 503, "Active connector kill switch must block ingestion with 503");

    const unaffectedOrgs = await expressCall("GET", "/api/v2/organizations", { token: tenantToken });
    assert.strictEqual(unaffectedOrgs.status, 200, "Unaffected read paths must stay 200 during scoped containment");

    // Step 4: Preserve safe forensic evidence & confirm zero decoy leakage
    const opsErrors = await expressCall("GET", "/api/v2/ops/errors", { token: supportToken });
    assert.strictEqual(opsErrors.status, 200);
    const receipts = await expressCall("GET", "/api/v2/receipts", { token: tenantToken });
    assert.strictEqual(receipts.status, 200);
    const forensicSurface = JSON.stringify({
      opsErrors: opsErrors.body,
      receipts: receipts.body,
      telemetry: telemetry.snapshot(),
      decoyResponse: decoyRes.body
    });
    assert.ok(!forensicSurface.includes(decoyCanary), "Decoy canary leaked into telemetry, receipts, or error response!");
  } finally {
    // Step 5: Recover — deactivate kill switch & run post-recovery smoke verification
    const deactivateRes = await expressCall("POST", "/api/v2/ops/kill-switches", {
      token: supportToken,
      body: {
        scope: "connector:zoikotime",
        active: false
      }
    });
    assert.strictEqual(deactivateRes.status, 200);
  }

  const recoverySmoke = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
    token: tenantToken,
    headers: { "idempotency-key": `inc-recover-${crypto.randomUUID()}` },
    body: {
      connectionId: zoikoConn.id,
      batchId: `inc-recover-${crypto.randomUUID()}`,
      items: [
        {
          recordId: `inc-rec-ok-${crypto.randomUUID().slice(0, 8)}`,
          revision: 1,
          subjectRef: "emp-inc-ok",
          startUtc: "2026-03-03T10:00:00Z",
          endUtc: "2026-03-03T11:00:00Z",
          workTz: "Europe/London",
          kind: "WORK"
        }
      ]
    }
  });
  assert.strictEqual(recoverySmoke.status, 200, "Post-recovery smoke batch must return 200 OK");
  const recoveredAtMs = Date.now();

  const report = {
    schema: "abate.incident-exercise.v1",
    generatedAt: new Date(recoveredAtMs).toISOString(),
    incidentLead: "incident.lead.sre",
    scenario: "Prohibited surveillance decoy transmitted by connector -> scoped kill-switch containment -> forensic check -> recovery",
    containedScope: "connector:zoikotime",
    timestamps: {
      startedAt: new Date(exerciseStartMs).toISOString(),
      detectedAt: new Date(detectedAtMs).toISOString(),
      containedAt: new Date(containedAtMs).toISOString(),
      recoveredAt: new Date(recoveredAtMs).toISOString()
    },
    timeToDetectMs: detectedAtMs - exerciseStartMs,
    timeToContainMs: containedAtMs - detectedAtMs,
    timeToRecoverMs: recoveredAtMs - containedAtMs,
    telemetryLeakCount: 0,
    unaffectedPathStatus: 200,
    containedPathStatus: 503,
    postRecoverySmokeStatus: recoverySmoke.status,
    passed: true
  };

  const outPath = path.resolve(__dirname, "../../evidence/incident-exercise-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`  ✔ Detected in ${report.timeToDetectMs}ms, contained in ${report.timeToContainMs}ms, recovered in ${report.timeToRecoverMs}ms`);
  console.log(`  ✔ Telemetry / receipt / error decoy leaks: 0`);
  console.log(`  ✔ Wrote ${outPath}\n`);
}

main().catch((err) => {
  console.error("\x1b[31m[INCIDENT EXERCISE FAILED]\x1b[0m", err);
  process.exit(1);
});
