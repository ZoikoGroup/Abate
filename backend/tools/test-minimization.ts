// backend/tools/test-minimization.ts
// Decoy Minimization Lab (Guide §2.5.1 & §8.9)
// Verifies that forbidden surveillance and decoy fields (e.g. screenshotUrl, sickReason, windowTitle)
// are strictly rejected before persistence and leave ZERO trace in database tables, logs, receipts, or audit records.

import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, authenticate, resolveActor } from "../src/domains/tenant/auth";
import { ingestBatch } from "../src/domains/ingest/ingest-batch";
import { withTenant, memDb } from "../src/platform/db/with-tenant";
import { ZoikoTimeBatch } from "../src/contracts/sources/zoikotime.v1";

console.log("\x1b[36m=== Abate Task Runner: test-minimization (Decoy Minimization Lab) ===\x1b[0m");

const DECOY_MARKER_1 = "DECOY_SICK_REASON_7f3a";
const DECOY_MARKER_2 = "DECOY_KEYSTROKE_LOGGER_9b4c";
const DECOY_MARKER_3 = "DECOY_SCREENSHOT_PATH_3d1e";

let passed = 0;

function check(name: string, fn: () => void | Promise<void>) {
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

async function run() {
  // Step 1: Initialize synthetic baseline fixture
  await check("Seed two-tenant environment with active connectors", async () => {
    await seedTwoTenants();
  });

  const tokenA = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  });

  const whoA = await authenticate(`Bearer ${tokenA}`);
  const actorA = await resolveActor(whoA.tenantId, whoA.subject);

  // Find the active connector for Tenant A
  let connectionId = "";
  await withTenant(whoA.tenantId, async (tx) => {
    const r = await tx.q("SELECT id FROM connection WHERE source = 'zoikotime' AND state = 'ACTIVE' LIMIT 1");
    assert((r.rowCount ?? 0) > 0, "Active ZoikoTime connection must exist");
    connectionId = r.rows[0].id;
  });

  // Step 2: Intercept stdout/stderr to ensure no decoy values are leaked via logger
  let capturedLogs = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  // Hook process output
  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    capturedLogs += chunk?.toString?.() || "";
    return originalStdoutWrite(chunk, ...args);
  };
  (process.stderr as any).write = (chunk: any, ...args: any[]) => {
    capturedLogs += chunk?.toString?.() || "";
    return originalStderrWrite(chunk, ...args);
  };

  const batchId = `batch-decoy-lab-${crypto.randomUUID()}`;

  // Step 3: Construct adversarial batch mixing valid items and decoy items
  const adversarialBatch: ZoikoTimeBatch = {
    connectionId,
    batchId,
    items: [
      // Compliant item
      {
        recordId: "rec-clean-001",
        revision: 1,
        subjectRef: "emp-alpha-101",
        startUtc: "2026-03-02T09:00:00Z",
        endUtc: "2026-03-02T12:00:00Z",
        workTz: "Europe/London",
        kind: "WORK"
      },
      // Decoy Item 1: Injected sickReason (medical reason prohibited)
      {
        recordId: "rec-decoy-001",
        revision: 1,
        subjectRef: "emp-alpha-102",
        startUtc: "2026-03-02T09:00:00Z",
        endUtc: "2026-03-02T11:00:00Z",
        workTz: "Europe/London",
        kind: "WORK",
        sickReason: DECOY_MARKER_1
      } as any,
      // Decoy Item 2: Injected keystroke surveillance
      {
        recordId: "rec-decoy-002",
        revision: 1,
        subjectRef: "emp-alpha-103",
        startUtc: "2026-03-02T13:00:00Z",
        endUtc: "2026-03-02T17:00:00Z",
        workTz: "Europe/London",
        kind: "WORK",
        keystrokeTracker: DECOY_MARKER_2
      } as any,
      // Decoy Item 3: Injected screenshot URL & window title
      {
        recordId: "rec-decoy-003",
        revision: 1,
        subjectRef: "emp-alpha-104",
        startUtc: "2026-03-02T14:00:00Z",
        endUtc: "2026-03-02T16:00:00Z",
        workTz: "Europe/London",
        kind: "WORK",
        screenshotUrl: `https://vault.internal/artifacts/${DECOY_MARKER_3}.png`,
        windowTitle: `Confidential Document - ${DECOY_MARKER_3}`
      } as any
    ]
  };

  let ingestResult: any;

  try {
    ingestResult = await ingestBatch({
      who: whoA,
      actor: actorA,
      batch: adversarialBatch,
      idempotencyKey: batchId
    });
  } finally {
    // Restore stdout/stderr hooks
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  // Step 4: Verify receipt counts
  await check("Batch ingestion strictly accepts compliant items and rejects all decoy items", () => {
    assert.strictEqual(ingestResult.status, 200);
    assert.strictEqual(ingestResult.body.accepted, 1, "Only 1 compliant item must be accepted");
    assert.strictEqual(ingestResult.body.rejected, 3, "All 3 decoy items must be rejected");
    assert.strictEqual(ingestResult.body.duplicate, 0);
    assert.strictEqual(ingestResult.body.conflicted, 0);
  });

  // Step 5: Verify Decoy Marker 1 is absent from application stdout/stderr logs
  await check("Process logs contain 0 occurrences of decoy strings", () => {
    assert(!capturedLogs.includes(DECOY_MARKER_1), `Stdout/stderr must not contain ${DECOY_MARKER_1}`);
    assert(!capturedLogs.includes(DECOY_MARKER_2), `Stdout/stderr must not contain ${DECOY_MARKER_2}`);
    assert(!capturedLogs.includes(DECOY_MARKER_3), `Stdout/stderr must not contain ${DECOY_MARKER_3}`);
  });

  // Step 6: Scan all database tables for zero trace of any decoy string
  await check("Database tables (work_fact_revision, audit, receipts, outbox, idempotency) contain 0 trace of decoys", async () => {
    await withTenant(whoA.tenantId, async (tx) => {
      // 1. work_fact_revision
      const wf = await tx.q("SELECT * FROM work_fact_revision");
      const wfStr = JSON.stringify(wf.rows);
      assert(!wfStr.includes(DECOY_MARKER_1), "work_fact_revision must not contain decoy 1");
      assert(!wfStr.includes(DECOY_MARKER_2), "work_fact_revision must not contain decoy 2");
      assert(!wfStr.includes(DECOY_MARKER_3), "work_fact_revision must not contain decoy 3");

      // 2. ingest_receipt (must only store aggregate counts, no sensitive values)
      const rc = await tx.q("SELECT * FROM ingest_receipt");
      assert((rc.rowCount ?? 0) > 0, "Ingest receipt must be persisted");
      const rcStr = JSON.stringify(rc.rows);
      assert(!rcStr.includes(DECOY_MARKER_1), "ingest_receipt must not contain decoy 1");
      assert(!rcStr.includes(DECOY_MARKER_2), "ingest_receipt must not contain decoy 2");
      assert(!rcStr.includes(DECOY_MARKER_3), "ingest_receipt must not contain decoy 3");

      // 3. audit_event
      const audStr = JSON.stringify(memDb.auditEvents);
      assert(!audStr.includes(DECOY_MARKER_1), "audit_event must not contain decoy 1");
      assert(!audStr.includes(DECOY_MARKER_2), "audit_event must not contain decoy 2");
      assert(!audStr.includes(DECOY_MARKER_3), "audit_event must not contain decoy 3");

      // 4. outbox_event
      const obStr = JSON.stringify(memDb.outboxEvents);
      assert(!obStr.includes(DECOY_MARKER_1), "outbox_event must not contain decoy 1");
      assert(!obStr.includes(DECOY_MARKER_2), "outbox_event must not contain decoy 2");
      assert(!obStr.includes(DECOY_MARKER_3), "outbox_event must not contain decoy 3");

      // 5. idempotency_record
      const idemStr = JSON.stringify(Array.from(memDb.idempotency.values()));
      assert(!idemStr.includes(DECOY_MARKER_1), "idempotency_record must not contain decoy 1");
      assert(!idemStr.includes(DECOY_MARKER_2), "idempotency_record must not contain decoy 2");
      assert(!idemStr.includes(DECOY_MARKER_3), "idempotency_record must not contain decoy 3");
    });
  });

  // Step 7: Verify memory DB dump has zero occurrences
  await check("Complete memory snapshot dump has zero occurrences of decoy strings", () => {
    const dumpedJson = JSON.stringify(memDb, (_key, value) => {
      if (value instanceof Map) return Array.from(value.entries());
      if (value instanceof Set) return Array.from(value.values());
      return value;
    });
    assert(!dumpedJson.includes(DECOY_MARKER_1), "Database dump must have 0 matches for DECOY_MARKER_1");
    assert(!dumpedJson.includes(DECOY_MARKER_2), "Database dump must have 0 matches for DECOY_MARKER_2");
    assert(!dumpedJson.includes(DECOY_MARKER_3), "Database dump must have 0 matches for DECOY_MARKER_3");
  });

  console.log(`\x1b[32m[SUCCESS] All ${passed} decoy minimization tests passed: 0 traces detected.\x1b[0m\n`);
}

run().catch((err) => {
  console.error("\x1b[31m[MINIMIZATION LAB FAILED]\x1b[0m", err);
  process.exit(1);
});
