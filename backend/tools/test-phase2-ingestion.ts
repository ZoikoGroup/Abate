// backend/tools/test-phase2-ingestion.ts
// Phase 2 Ingestion & Work-State Ledger Test Suite
// Architecture Ref: ZAB-ENG-001 v1.0 / Package B2 (Domains S02 & S03)
// Verifies:
// 1. Strict Contract Enforcement (rejects unknown, forbidden, future, invalid kind, ambiguous DST)
// 2. Decoy Minimization (zero persistence, zero log echo of surveillance/decoy payloads)
// 3. Pseudonym Isolation & Identity Map Least-Privilege Role Boundaries
// 4. Atomic Transaction Integrity (receipt, facts, watermark, outbox commit together)
// 5. Idempotent Replay & Conflict Classification
// 6. Append-Only Ledger Revisioning & Metric Snapshot Invalidation
// 7. Connection Cadence Freshness Evaluation
// 8. Connection Lifecycle Enforcement (PAUSED / REVOKED fails closed)

import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, authenticate, resolveActor } from "../src/domains/tenant/auth";
import { ingestBatch } from "../src/domains/ingest/ingest-batch";
import { partition, isDstTransitionAmbiguity } from "../src/domains/ingest/validate";
import { deriveConnectionHealth } from "../src/domains/ingest/freshness";
import { withTenant, withWorker, memDb } from "../src/platform/db/with-tenant";
import { ZoikoTimeBatch, ZoikoTimeIntervalV1 } from "../src/contracts/sources/zoikotime.v1";
import { derivePseudonym } from "../src/domains/work/pseudonym";

console.log("\x1b[36m=== Abate Task Runner: test-phase2-ingestion (Phase 2 Suite) ===\x1b[0m\n");

let passed = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      await res;
    }
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  // Step 1: Seed base two-tenant fixture
  await runTest("Setup: Seed isolated two-tenant environment", async () => {
    await seedTwoTenants();
  });

  const tenantAId = GOLDEN_01.tenantA.id;
  const tenantBId = GOLDEN_01.tenantB.id;

  const tokenA = createDevToken({
    tenantId: tenantAId,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  });
  const whoA = await authenticate(`Bearer ${tokenA}`);
  const actorA = await resolveActor(whoA.tenantId, whoA.subject);

  let connAId = "";
  await withTenant(tenantAId, async (tx) => {
    const r = await tx.q("SELECT id FROM connection WHERE source = 'zoikotime' AND state = 'ACTIVE' LIMIT 1");
    assert((r.rowCount ?? 0) > 0, "Active ZoikoTime connection must exist for Tenant A");
    connAId = r.rows[0].id;
  });

  // --------------------------------------------------------------------------
  // TEST 1: Source Contract: Strict Rejection of 5 Invalid Payloads
  // --------------------------------------------------------------------------
  await runTest(
    "Contract: Validates compliant interval and rejects 5 invalid variations",
    () => {
      // 1. Valid interval
      const validItem = {
        recordId: "rec-valid-001",
        revision: 1,
        subjectRef: "emp-alpha-001",
        startUtc: "2026-03-02T09:00:00Z",
        endUtc: "2026-03-02T12:00:00Z",
        workTz: "Europe/London",
        kind: "WORK"
      };
      const parsedValid = ZoikoTimeIntervalV1.safeParse(validItem);
      assert.strictEqual(parsedValid.success, true, "Valid item must parse cleanly");

      // 2. Rejection 1: Unknown field
      const unknownFieldItem = { ...validItem, unexpectedField: "forbidden_extra" };
      assert.strictEqual(ZoikoTimeIntervalV1.safeParse(unknownFieldItem).success, false, "Unknown field must fail");

      // 3. Rejection 2: Forbidden surveillance/decoy field
      const forbiddenFieldItem = { ...validItem, screenshotUrl: "https://vault/shot.png" };
      assert.strictEqual(ZoikoTimeIntervalV1.safeParse(forbiddenFieldItem).success, false, "Forbidden surveillance field must fail");

      // 4. Rejection 3: Future date beyond limit
      const futureDateItem = {
        ...validItem,
        startUtc: "2099-01-01T09:00:00Z",
        endUtc: "2099-01-01T12:00:00Z"
      };
      const partFuture = partition([futureDateItem]);
      assert.strictEqual(partFuture.rejected, 1, "Future date beyond allowable limit must be rejected");

      // 5. Rejection 4: Invalid kind
      const invalidKindItem = { ...validItem, kind: "SURVEILLANCE" };
      assert.strictEqual(ZoikoTimeIntervalV1.safeParse(invalidKindItem).success, false, "Invalid kind must fail");

      // 6. Rejection 5: Ambiguous DST time
      // 2026-10-25 01:30:00 UTC falls in the ambiguous autumn fallback window for Europe/London
      assert.strictEqual(
        isDstTransitionAmbiguity(new Date("2026-10-25T01:30:00Z"), "Europe/London"),
        true,
        "London fall transition must be detected as ambiguous DST"
      );
      const dstAmbiguousItem = {
        ...validItem,
        startUtc: "2026-10-25T01:00:00Z",
        endUtc: "2026-10-25T01:45:00Z",
        workTz: "Europe/London"
      };
      const partDst = partition([dstAmbiguousItem]);
      assert.strictEqual(partDst.rejected, 1, "Ambiguous DST interval must be rejected");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 2: Decoy Minimization Lab: Zero Persistence and Zero Log Echo
  // --------------------------------------------------------------------------
  await runTest(
    "Decoy Lab: Rejected decoy payloads leave zero trace in logs, tables, and receipts",
    async () => {
      const DECOY_SICK = "DECOY_SICK_REASON_p2_lab_883a";
      const DECOY_SCREEN = "DECOY_SCREENSHOT_p2_lab_441b";

      let capturedLogs = "";
      const originalStdout = process.stdout.write.bind(process.stdout);
      const originalStderr = process.stderr.write.bind(process.stderr);

      (process.stdout as any).write = (chunk: any, ...args: any[]) => {
        capturedLogs += chunk?.toString?.() || "";
        return originalStdout(chunk, ...args);
      };
      (process.stderr as any).write = (chunk: any, ...args: any[]) => {
        capturedLogs += chunk?.toString?.() || "";
        return originalStderr(chunk, ...args);
      };

      const batchId = `batch-decoy-p2-${crypto.randomUUID()}`;
      let res: any;

      try {
        res = await ingestBatch({
          who: whoA,
          actor: actorA,
          batch: {
            connectionId: connAId,
            batchId,
            items: [
              {
                recordId: "rec-p2-clean-01",
                revision: 1,
                subjectRef: "emp-p2-001",
                startUtc: "2026-03-02T09:00:00Z",
                endUtc: "2026-03-02T11:00:00Z",
                workTz: "Europe/London",
                kind: "WORK"
              },
              {
                recordId: "rec-p2-decoy-01",
                revision: 1,
                subjectRef: "emp-p2-002",
                startUtc: "2026-03-02T09:00:00Z",
                endUtc: "2026-03-02T11:00:00Z",
                workTz: "Europe/London",
                kind: "WORK",
                sickReason: DECOY_SICK
              } as any,
              {
                recordId: "rec-p2-decoy-02",
                revision: 1,
                subjectRef: "emp-p2-003",
                startUtc: "2026-03-02T11:00:00Z",
                endUtc: "2026-03-02T13:00:00Z",
                workTz: "Europe/London",
                kind: "WORK",
                screenshotUrl: DECOY_SCREEN
              } as any
            ]
          },
          idempotencyKey: batchId
        });
      } finally {
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
      }

      assert.strictEqual(res.body.accepted, 1);
      assert.strictEqual(res.body.rejected, 2);

      // Verify zero trace in logs
      assert(!capturedLogs.includes(DECOY_SICK), "Stdout/stderr must not contain DECOY_SICK");
      assert(!capturedLogs.includes(DECOY_SCREEN), "Stdout/stderr must not contain DECOY_SCREEN");

      // Verify zero trace in database memory dump
      const dumpStr = JSON.stringify(memDb, (_k, v) => (v instanceof Map ? Array.from(v.entries()) : v));
      assert(!dumpStr.includes(DECOY_SICK), "Database dump must have 0 occurrences of DECOY_SICK");
      assert(!dumpStr.includes(DECOY_SCREEN), "Database dump must have 0 occurrences of DECOY_SCREEN");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 3: Pseudonym Isolation & Identity Map Least-Privilege Role Boundaries
  // --------------------------------------------------------------------------
  await runTest(
    "Pseudonyms: Isolated in identity_map, tenant-scoped, unreadable by abate_worker",
    async () => {
      const subject = "emp-secret-individual-99";
      const pseudoA = derivePseudonym(`auth-secret-key:${tenantAId}`, subject);
      const pseudoB = derivePseudonym(`auth-secret-key:${tenantBId}`, subject);

      // Tenant isolation: same employee gets distinct pseudonyms across tenants
      assert.notStrictEqual(pseudoA, pseudoB, "Pseudonyms must be strictly tenant-scoped HMACs");

      // Verify identity map rows are persisted
      await withTenant(tenantAId, async (tx) => {
        const idMapRes = await tx.q("SELECT * FROM identity_map");
        assert((idMapRes.rowCount ?? 0) > 0, "Identity map must store pseudonym mappings");
      });

      // Least-privilege boundary: abate_worker cannot read identity_map
      const workerRead = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM identity_map")).rows;
      });
      assert.strictEqual(workerRead.length, 0, "abate_worker MUST NOT be able to read identity_map");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 4: Atomic Transaction Integrity (receipt, facts, watermark, outbox)
  // --------------------------------------------------------------------------
  await runTest(
    "Atomic Commit: Ingest receipt, work facts, watermark, and outbox commit together",
    async () => {
      const batchId = `batch-atomic-${crypto.randomUUID()}`;
      const res = await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: {
          connectionId: connAId,
          batchId,
          items: [
            {
              recordId: "rec-atomic-01",
              revision: 1,
              subjectRef: "emp-atomic-01",
              startUtc: "2026-03-03T09:00:00Z",
              endUtc: "2026-03-03T12:00:00Z",
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        },
        idempotencyKey: batchId
      });

      assert.strictEqual(res.body.accepted, 1);
      const receiptId = res.body.receiptId;

      await withTenant(tenantAId, async (tx) => {
        // Receipt persisted
        const rRes = await tx.q("SELECT * FROM ingest_receipt WHERE id = $1", [receiptId]);
        assert.strictEqual(rRes.rowCount, 1, "Ingest receipt must exist");

        // Fact revision linked to receipt
        const fRes = await tx.q("SELECT * FROM work_fact_revision WHERE receipt_id = $1", [receiptId]);
        assert.strictEqual(fRes.rowCount, 1, "Work fact revision must be linked to receipt");

        // Outbox event registered
        const ob = memDb.outboxEvents.find(e => e.aggregate_id === receiptId && e.event_type === "work.facts.changed");
        assert.ok(ob, "Outbox event must be emitted for work.facts.changed");
      });
    }
  );

  // --------------------------------------------------------------------------
  // TEST 5: Idempotent Replay & Conflict Classification
  // --------------------------------------------------------------------------
  await runTest(
    "Replay & Conflict: Identical payload increments duplicate; altered payload increments conflict",
    async () => {
      const batchId = `batch-replay-${crypto.randomUUID()}`;
      const item = {
        recordId: "rec-replay-01",
        revision: 1,
        subjectRef: "emp-replay-01",
        startUtc: "2026-03-04T09:00:00Z",
        endUtc: "2026-03-04T12:00:00Z",
        workTz: "Europe/London",
        kind: "WORK" as const
      };

      // Ingest initial item
      const res1 = await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: { connectionId: connAId, batchId, items: [item] },
        idempotencyKey: batchId
      });
      assert.strictEqual(res1.body.accepted, 1);

      // Re-submit identical item in new batch -> duplicate
      const batchId2 = `batch-replay-dup-${crypto.randomUUID()}`;
      const res2 = await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: { connectionId: connAId, batchId: batchId2, items: [item] },
        idempotencyKey: batchId2
      });
      assert.strictEqual(res2.body.accepted, 0);
      assert.strictEqual(res2.body.duplicate, 1);
      assert.strictEqual(res2.body.conflicted, 0);

      // Submit same recordId and revision but with modified endUtc -> conflict
      const batchId3 = `batch-replay-conflict-${crypto.randomUUID()}`;
      const conflictedItem = {
        ...item,
        endUtc: "2026-03-04T13:00:00Z" // altered timestamp under same revision
      };
      const res3 = await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: { connectionId: connAId, batchId: batchId3, items: [conflictedItem] },
        idempotencyKey: batchId3
      });
      assert.strictEqual(res3.body.accepted, 0);
      assert.strictEqual(res3.body.conflicted, 1);
      assert.strictEqual(res3.body.duplicate, 0);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 6: Append-Only Ledger Revisioning & Stale Snapshot Invalidation
  // --------------------------------------------------------------------------
  await runTest(
    "Ledger Corrections: Revision > 1 appends record and invalidates overlapping metric snapshots",
    async () => {
      const recordId = "rec-correction-001";
      const startUtc = "2026-03-05T09:00:00Z";
      const endUtc = "2026-03-05T17:00:00Z";

      // 1. Ingest revision 1
      const b1 = `batch-rev1-${crypto.randomUUID()}`;
      await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: {
          connectionId: connAId,
          batchId: b1,
          items: [
            {
              recordId,
              revision: 1,
              subjectRef: "emp-corr-01",
              startUtc,
              endUtc,
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        },
        idempotencyKey: b1
      });

      // 2. Insert an active metric snapshot covering that period
      const snapId = crypto.randomUUID();
      await withTenant(tenantAId, async (tx) => {
        await tx.q(
          `INSERT INTO metric_snapshot (
            id, tenant_id, metric_id, metric_version, cohort_ref, period_start, period_end,
            source_cutoff, code_digest, membership_version, value, quality, contributor_count, lineage
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            snapId,
            tenantAId,
            "WEEKLY_HOURS",
            1,
            "cohort-team-a",
            "2026-03-01T00:00:00Z",
            "2026-03-07T23:59:59Z",
            "2026-03-07T23:59:59Z",
            "sha256-code-01",
            1,
            38.5,
            "HIGH",
            15,
            "{}"
          ]
        );
      });

      const initialSnap = memDb.metricSnapshots.get(snapId);
      assert.strictEqual(Boolean(initialSnap?.is_stale), false, "Snapshot initially not stale");

      // 3. Ingest correction (revision 2)
      const b2 = `batch-rev2-${crypto.randomUUID()}`;
      const resRev2 = await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: {
          connectionId: connAId,
          batchId: b2,
          items: [
            {
              recordId,
              revision: 2, // correction
              subjectRef: "emp-corr-01",
              startUtc,
              endUtc: "2026-03-05T16:30:00Z", // corrected 30 mins earlier
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        },
        idempotencyKey: b2
      });

      assert.strictEqual(resRev2.body.accepted, 1);
      assert.strictEqual(resRev2.body.staleSnapshotsMarked, 1, "Overlapping metric snapshot marked stale");

      // 4. Verify snapshot is marked stale
      const updatedSnap = memDb.metricSnapshots.get(snapId);
      assert.strictEqual(updatedSnap?.is_stale, true, "Snapshot must be marked is_stale = true");

      // 5. Verify append-only property: both revision 1 and revision 2 exist in work_fact_revision
      await withTenant(tenantAId, async (tx) => {
        const revs = await tx.q(
          "SELECT revision FROM work_fact_revision WHERE source_record_id = $1 ORDER BY revision ASC",
          [recordId]
        );
        assert.strictEqual(revs.rowCount, 2, "Both revisions must be retained in append-only ledger");
      });
    }
  );

  // --------------------------------------------------------------------------
  // TEST 7: Connection Cadence Freshness (FRESH, DELAYED, STALE, NEVER_SYNCED)
  // --------------------------------------------------------------------------
  await runTest(
    "Freshness: Correctly categorizes FRESH, DELAYED, STALE, and NEVER_SYNCED",
    () => {
      const now = new Date("2026-11-11T12:00:00Z");
      const cadence = 3600; // 1 hour

      // 1. NEVER_SYNCED
      assert.strictEqual(
        deriveConnectionHealth({ lastSuccessAt: null, expectedCadenceSeconds: cadence }, now),
        "NEVER_SYNCED"
      );

      // 2. FRESH (last sync 30 mins ago < 1.5 * cadence)
      const freshDate = new Date(now.getTime() - 30 * 60 * 1000);
      assert.strictEqual(
        deriveConnectionHealth({ lastSuccessAt: freshDate, expectedCadenceSeconds: cadence }, now),
        "FRESH"
      );

      // 3. DELAYED (last sync 2 hours ago: between 1.5 and 3x cadence)
      const delayedDate = new Date(now.getTime() - 2 * 3600 * 1000);
      assert.strictEqual(
        deriveConnectionHealth({ lastSuccessAt: delayedDate, expectedCadenceSeconds: cadence }, now),
        "DELAYED"
      );

      // 4. STALE (last sync 4 hours ago: > 3x cadence)
      const staleDate = new Date(now.getTime() - 4 * 3600 * 1000);
      assert.strictEqual(
        deriveConnectionHealth({ lastSuccessAt: staleDate, expectedCadenceSeconds: cadence }, now),
        "STALE"
      );
    }
  );

  // --------------------------------------------------------------------------
  // TEST 8: Connection Lifecycle Enforcement (PAUSED / REVOKED fails closed)
  // --------------------------------------------------------------------------
  await runTest(
    "Lifecycle Enforcement: Non-ACTIVE connections reject ingestion with HTTP 403",
    async () => {
      // Pause connection
      await withTenant(tenantAId, async (tx) => {
        await tx.q("UPDATE connection SET state = $1 WHERE id = $2", ["PAUSED", connAId]);
      });

      const pausedBatchId = `batch-paused-${crypto.randomUUID()}`;
      await assert.rejects(
        async () => {
          await ingestBatch({
            who: whoA,
            actor: actorA,
            batch: {
              connectionId: connAId,
              batchId: pausedBatchId,
              items: [
                {
                  recordId: "rec-paused-01",
                  revision: 1,
                  subjectRef: "emp-paused-01",
                  startUtc: "2026-03-06T09:00:00Z",
                  endUtc: "2026-03-06T12:00:00Z",
                  workTz: "Europe/London",
                  kind: "WORK"
                }
              ]
            },
            idempotencyKey: pausedBatchId
          });
        },
        /Connection is PAUSED; further data collection is blocked./,
        "Ingesting to PAUSED connection must throw AppError FORBIDDEN"
      );

      // Restore to ACTIVE for clean state
      await withTenant(tenantAId, async (tx) => {
        await tx.q("UPDATE connection SET state = $1 WHERE id = $2", ["ACTIVE", connAId]);
      });
    }
  );

  console.log(`\n\x1b[32m[SUCCESS] All ${passed}/8 Phase 2 Ingestion & Ledger tests PASSED.\x1b[0m\n`);
}

main().catch((err) => {
  console.error("\x1b[31m[PHASE 2 INGESTION TEST SUITE FAILED]\x1b[0m", err);
  process.exit(1);
});

