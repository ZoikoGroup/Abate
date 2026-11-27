// backend/tools/test-worker-crash-lab.ts
// Module 1 / Step 2: Worker Daemon Crash Lab & Concurrency Verification Test Suite.
// Verifies:
// 1. Crash after publish: event redelivered, consumer skips duplicate, exactly one business effect.
// 2. Poison event reaches dead-letter after 5 attempts; subsequent events continue unblocked.
// 3. Strict references only in dead-letter rows, never raw payloads.
// 4. Two concurrent workers with FOR UPDATE SKIP LOCKED never double-publish.
// 5. Consumer out-of-order version detection.
// 6. Live ops jobs metrics & status reflection.

import assert from "node:assert";
import crypto from "node:crypto";
import { checkPgHealth, migratorPool, withTenant, withWorker } from "../src/platform/db/with-tenant";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { EventBus, prunePublishedOutbox } from "../src/worker/outbox-publisher";
import {
  drainBatch,
  getWorkerMetrics,
  resetWorkerMetrics,
  runScheduledOutboxPrunePass
} from "../src/worker/daemon";

interface TestReport {
  id: number;
  name: string;
  status: "PASSED" | "FAILED";
  durationMs: number;
  error?: string;
}

const reports: TestReport[] = [];
let passedCount = 0;
const startTotal = Date.now();

console.log("\x1b[36m=== Abate Task Runner: test-worker-crash-lab (Module 1 Worker Daemon) ===\x1b[0m\n");

async function runTest(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  const id = reports.length + 1;
  try {
    await fn();
    const dur = Date.now() - t0;
    reports.push({ id, name, status: "PASSED", durationMs: dur });
    passedCount++;
    console.log(`  \x1b[32m✔ PASS\x1b[0m [Test ${id}] ${name} (${dur}ms)`);
  } catch (err: any) {
    const dur = Date.now() - t0;
    reports.push({ id, name, status: "FAILED", durationMs: dur, error: err.message });
    console.error(`  \x1b[31m✖ FAIL\x1b[0m [Test ${id}] ${name} (${dur}ms)`);
    console.error(`         ${err.stack || err.message}`);
  }
}

async function main() {
  const tenantA = GOLDEN_01.tenantA.id;

  // Drain any pre-existing outbox backlog left by earlier suites sharing a live PostgreSQL instance
  const preDrainBus = new EventBus();
  const preDrainConsumer = `consumer-predrain-${crypto.randomUUID().slice(0, 8)}`;
  for (let round = 0; round < 20; round++) {
    const res = await drainBatch({
      bus: preDrainBus,
      consumerName: preDrainConsumer,
      batchSize: 100
    });
    if (res.processed === 0 && res.skipped === 0 && res.failures === 0) break;
  }
  resetWorkerMetrics();

  // --------------------------------------------------------------------------
  // TEST 1: Crash after publish but before marking published
  // --------------------------------------------------------------------------
  await runTest(
    "Worker crash after publish re-delivers event, consumer inbox dedupes, exactly one business effect",
    async () => {
      resetWorkerMetrics();
      const testBus = new EventBus();
      let businessEffectCount = 0;
      const testConsumer = `consumer-crash-${crypto.randomUUID().slice(0, 8)}`;

      // Register consumer handler that increments business effect counter
      testBus.subscribe(testConsumer, "*", async () => {
        businessEffectCount++;
      });

      // 1. Queue an event in outbox for Tenant A
      const eventId = crypto.randomUUID();
      const aggId = crypto.randomUUID();
      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            eventId,
            tenantA,
            "organization",
            aggId,
            1,
            "ORG_CREATED",
            "org.v1",
            "Tenant unit creation",
            JSON.stringify([{ kind: "org", id: aggId }])
          ]
        );
      });

      // 2. Worker attempt 1: crashes AFTER bus.publish, BEFORE marking published_at in db
      let crashCaught = false;
      try {
        await drainBatch({
          bus: testBus,
          consumerName: testConsumer,
          simulateCrashAfterPublish: true
        });
      } catch (err: any) {
        if (err.message === "SIMULATED_WORKER_CRASH_AFTER_PUBLISH") {
          crashCaught = true;
        }
      }
      assert.strictEqual(crashCaught, true, "Worker must simulate crash after publish");
      assert.strictEqual(businessEffectCount, 1, "First delivery must trigger one business effect");

      // Verify event in outbox is still unpublished
      const unpublishedCheck = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [eventId])).rows[0];
      });
      assert.strictEqual(unpublishedCheck.published_at, null, "Outbox event must remain unpublished after worker crash");

      // 3. Worker attempt 2 (recovery): re-reads event and redelivers
      const secondDrain = await drainBatch({
        bus: testBus,
        consumerName: testConsumer,
        simulateCrashAfterPublish: false
      });

      assert.strictEqual(secondDrain.processed, 1, "Second drain must re-process the uncommitted event");

      // Consumer inbox_event must have skipped duplicate delivery
      assert.strictEqual(
        businessEffectCount,
        1,
        "Consumer must deduplicate via inbox_event: exactly one business effect executed"
      );

      // Verify event is now marked published
      const finalCheck = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [eventId])).rows[0];
      });
      assert.ok(finalCheck.published_at, "Event must now be marked published");
      assert.strictEqual(finalCheck.state, "PUBLISHED", "Event state must be PUBLISHED");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 2: Poison event reaches dead-letter after 5 attempts; subsequent events continue unblocked
  // --------------------------------------------------------------------------
  await runTest(
    "Poison event reaches dead-letter state after 5 attempts and stores references only; healthy events continue unblocked",
    async () => {
      resetWorkerMetrics();
      const testBus = new EventBus();
      const poisonConsumer = `consumer-poison-${crypto.randomUUID().slice(0, 8)}`;

      // Handler that fails only for poison aggregate
      testBus.subscribe(poisonConsumer, "*", async (env) => {
        if (env.aggregate === "poison_aggregate") {
          throw new Error("UNRECOVERABLE_SYNTAX_ERROR: Poison payload format");
        }
      });

      // 1. Queue a poison event
      const poisonId = crypto.randomUUID();
      const poisonAggId = crypto.randomUUID();
      const poisonRef = [{ kind: "poison_record", id: poisonAggId }];

      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            poisonId,
            tenantA,
            "poison_aggregate",
            poisonAggId,
            1,
            "POISON_MUTATION",
            "poison.v1",
            "Hazard condition test",
            JSON.stringify(poisonRef)
          ]
        );
      });

      // 2. Queue a healthy event immediately after the poison event
      const healthyId = crypto.randomUUID();
      const healthyAggId = crypto.randomUUID();
      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            healthyId,
            tenantA,
            "healthy_aggregate",
            healthyAggId,
            1,
            "HEALTHY_MUTATION",
            "healthy.v1",
            "Safe business event",
            JSON.stringify([{ kind: "healthy_record", id: healthyAggId }])
          ]
        );
      });

      // 3. Drain attempts 1 to 4: poison event retries, attempts counter increments
      for (let attempt = 1; attempt <= 4; attempt++) {
        // Fast-forward next_retry_at to now for testing backoff transitions (SQL works on live PG & memDb)
        await withWorker(async (tx) => {
          await tx.q(`UPDATE outbox_event SET next_retry_at = $1 WHERE id = $2`, [
            new Date(Date.now() - 1000).toISOString(),
            poisonId
          ]);
        });

        await drainBatch({
          bus: testBus,
          consumerName: poisonConsumer,
          maxAttempts: 5
        });

        const ev = await withWorker(async (tx) => {
          return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [poisonId])).rows[0];
        });
        assert.strictEqual(Number(ev?.attempts), attempt, `Poison event attempts must be ${attempt}`);
        assert.strictEqual(ev?.state, "PENDING", "State must remain PENDING during retry attempts");
      }

      // 4. Attempt 5: poison event must transition to DEAD_LETTER
      await withWorker(async (tx) => {
        await tx.q(`UPDATE outbox_event SET next_retry_at = $1 WHERE id = $2`, [
          new Date(Date.now() - 1000).toISOString(),
          poisonId
        ]);
      });

      const fifthDrain = await drainBatch({
        bus: testBus,
        consumerName: poisonConsumer,
        maxAttempts: 5
      });

      const evFinal = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [poisonId])).rows[0];
      });
      assert.strictEqual(fifthDrain.deadLetters, 1, "Fifth attempt must transition event to dead-letter");
      assert.strictEqual(evFinal?.state, "DEAD_LETTER", "Outbox state must be DEAD_LETTER");

      // Verify dead_letter_event row
      const deadLetterRows = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM dead_letter_event WHERE outbox_id = $1`, [poisonId])).rows;
      });

      assert.strictEqual(deadLetterRows.length, 1, "Dead-letter table must contain exactly 1 entry for poison event");
      const dlRow = deadLetterRows[0];
      assert.strictEqual(dlRow.tenant_id, tenantA, "Dead-letter must preserve tenant_id");
      assert.strictEqual(dlRow.attempts, 5, "Dead-letter must record 5 attempts");
      assert.ok(dlRow.last_error.includes("UNRECOVERABLE_SYNTAX_ERROR"), "Last error must be preserved");

      // CONSTITUTIONAL PRIVACY CHECK: Verify references ONLY, NEVER payloads
      assert.ok(Array.isArray(dlRow.refs), "Refs must be an array of references");
      assert.deepStrictEqual(dlRow.refs, poisonRef, "Refs must match references only");
      assert.strictEqual((dlRow as any).payload, undefined, "Dead-letter must NEVER store payload contents");

      // 5. Verify healthy event flows through unblocked
      const healthyCheck = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [healthyId])).rows[0];
      });
      assert.strictEqual(healthyCheck.state, "PUBLISHED", "Subsequent healthy event must process unblocked");
      assert.ok(healthyCheck.published_at, "Healthy event must have published_at timestamp");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 3: Concurrency - Two workers running together never double-publish (SKIP LOCKED)
  // --------------------------------------------------------------------------
  await runTest(
    "Two workers running concurrently with FOR UPDATE SKIP LOCKED never double-publish",
    async () => {
      resetWorkerMetrics();
      const testBus = new EventBus();
      const sharedConsumer = `concurrent-consumer-${crypto.randomUUID().slice(0, 8)}`;
      const processedEventIds: string[] = [];

      testBus.subscribe(sharedConsumer, "*", async (env) => {
        processedEventIds.push(env.eventId);
      });

      // Queue 10 events for Tenant A
      const eventIds: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const eid = crypto.randomUUID();
        eventIds.push(eid);
        await withTenant(tenantA, async (tx) => {
          await tx.q(
            `INSERT INTO outbox_event (
               id, tenant_id, aggregate, aggregate_id, aggregate_version,
               event_type, schema_version, purpose, refs
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              eid,
              tenantA,
              "batch_item",
              eid,
              i,
              "BATCH_PROCESSED",
              "batch.v1",
              "Concurrent queue test",
              JSON.stringify([{ kind: "item", index: i }])
            ]
          );
        });
      }

      // Execute Worker 1 and Worker 2 in parallel
      const worker1Promise = drainBatch({
        workerId: "worker-inst-1",
        batchSize: 5,
        bus: testBus,
        consumerName: sharedConsumer
      });
      const worker2Promise = drainBatch({
        workerId: "worker-inst-2",
        batchSize: 5,
        bus: testBus,
        consumerName: sharedConsumer
      });

      const [res1, res2] = await Promise.all([worker1Promise, worker2Promise]);

      // Drain remaining items if any
      const res3 = await drainBatch({
        workerId: "worker-inst-1",
        batchSize: 10,
        bus: testBus,
        consumerName: sharedConsumer
      });

      const totalDrained = res1.processed + res2.processed + res3.processed;
      assert.strictEqual(totalDrained, 10, "Total events processed across all workers must be exactly 10");

      // Verify no duplicates were processed
      const uniqueIds = new Set(processedEventIds);
      assert.strictEqual(
        uniqueIds.size,
        processedEventIds.length,
        "Every event must be published exactly once without duplicate processing"
      );
    }
  );

  // --------------------------------------------------------------------------
  // TEST 4: Consumer invariant - Detection of out-of-order versions
  // --------------------------------------------------------------------------
  await runTest(
    "Consumer out-of-order version detection flags stale or retrograde event versions",
    async () => {
      resetWorkerMetrics();
      const testBus = new EventBus();
      const versionConsumer = `consumer-version-${crypto.randomUUID().slice(0, 8)}`;
      const targetAggId = crypto.randomUUID();

      // 1. Queue version 2 first
      const v2Id = crypto.randomUUID();
      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [v2Id, tenantA, "versioned_doc", targetAggId, 2, "DOC_UPDATED", "doc.v1", "Doc edit", JSON.stringify([])]
        );
      });

      // Process version 2
      const drainV2 = await drainBatch({
        bus: testBus,
        consumerName: versionConsumer
      });
      assert.strictEqual(drainV2.processed, 1, "Version 2 must process successfully");

      // Simulate worker restart (clears in-process metrics; durable worker_consumer_version must persist!)
      resetWorkerMetrics();

      // 2. Queue version 1 (out-of-order)
      const v1Id = crypto.randomUUID();
      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [v1Id, tenantA, "versioned_doc", targetAggId, 1, "DOC_CREATED", "doc.v1", "Stale event", JSON.stringify([])]
        );
      });

      // Process version 1: strictly older than version 2 -> dropped even after worker restart
      const drainV1 = await drainBatch({
        bus: testBus,
        consumerName: versionConsumer
      });
      assert.strictEqual(drainV1.skipped, 1, "Stale version must be skipped even after worker restart");
      assert.strictEqual(drainV1.failures, 0, "Stale version must not count as a failure");
      assert.strictEqual(drainV1.deadLetters, 0, "Stale version must not be dead-lettered");

      const ev1 = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [v1Id])).rows[0];
      });
      assert.strictEqual(ev1?.state, "PUBLISHED", "Stale event is closed out, not left to retry");
      const dl1 = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM dead_letter_event WHERE outbox_id = $1`, [v1Id])).rows;
      });
      assert.strictEqual(dl1.length, 0, "Stale event must not reach dead-letter");
    }
  );

  await runTest(
    "A retry of an already-consumed event version is not treated as stale",
    async () => {
      resetWorkerMetrics();
      const testBus = new EventBus();
      const consumerName = `consumer-retry-${crypto.randomUUID().slice(0, 8)}`;
      const aggId = crypto.randomUUID();
      const delivered: number[] = [];
      testBus.subscribe(consumerName, "*", async (env) => {
        delivered.push(env.aggregateVersion);
      });

      const ids: string[] = [];
      for (const v of [1, 2]) {
        const id = crypto.randomUUID();
        ids.push(id);
        await withTenant(tenantA, async (tx) => {
          await tx.q(
            `INSERT INTO outbox_event (
               id, tenant_id, aggregate, aggregate_id, aggregate_version,
               event_type, schema_version, purpose, refs
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, tenantA, "retried_doc", aggId, v, "DOC_UPDATED", "doc.v1", "Retry test", JSON.stringify([])]
          );
        });
      }
      const first = await drainBatch({ bus: testBus, consumerName });
      assert.strictEqual(first.processed, 2);

      // Version 2 is re-queued (e.g. its PUBLISHED mark was lost): the retry must be delivered, not flagged stale
      await withWorker(async (tx) => {
        await tx.q(
          `UPDATE outbox_event SET state = 'PENDING', published_at = NULL, next_retry_at = now() WHERE id = $1`,
          [ids[1]]
        );
      });
      const retry = await drainBatch({ bus: testBus, consumerName });
      assert.strictEqual(retry.skipped, 0, "Same-version retry must not be skipped");
      assert.strictEqual(retry.failures, 0, "Same-version retry must not fail");
      assert.strictEqual(retry.processed, 1, "Same-version retry must be processed");
      const ev2 = await withWorker(async (tx) => {
        return (await tx.q(`SELECT * FROM outbox_event WHERE id = $1`, [ids[1]])).rows[0];
      });
      assert.strictEqual(ev2?.state, "PUBLISHED");
      assert.deepStrictEqual(delivered, [1, 2], "Inbox dedupe keeps the business effect single");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 5: Operations & Job endpoints reflect live worker metrics
  // --------------------------------------------------------------------------
  await runTest(
    "Worker metrics and heartbeat are actively tracked and queryable for operations monitoring",
    async () => {
      const metrics = getWorkerMetrics();
      assert.ok(metrics.workerId, "WorkerId must be assigned");
      assert.ok(metrics.heartbeatAt, "Heartbeat must be set on worker run");
      assert.ok(typeof metrics.queueLagMs === "number", "Queue lag must be tracked as milliseconds");
      assert.ok(metrics.totalProcessed >= 1, "Total processed counter must reflect executed jobs");
      assert.ok(metrics.lastRunAt, "Last run timestamp must be recorded");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 6: Least-Privilege Role Boundary: abate_worker cannot read business tables
  // --------------------------------------------------------------------------
  await runTest(
    "abate_worker least-privilege boundary: fails closed on business tables (work_fact_revision, principal, organization)",
    async () => {
      const assertWorkerDeniedOrEmpty = async (tableName: string) => {
        try {
          const rows = await withWorker(async (tx) => {
            return (await tx.q(`SELECT * FROM ${tableName} LIMIT 1`)).rows;
          });
          assert.strictEqual(rows.length, 0, `abate_worker MUST NOT read ${tableName}`);
        } catch (err: any) {
          assert.ok(
            err?.code === "42501" || /permission denied/i.test(String(err?.message || "")),
            `Unexpected error querying ${tableName} as abate_worker: ${err?.message}`
          );
        }
      };

      await assertWorkerDeniedOrEmpty("work_fact_revision");
      await assertWorkerDeniedOrEmpty("principal");
      await assertWorkerDeniedOrEmpty("organization");

      // 4. Worker CAN read outbox_event
      const outboxResult = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM outbox_event LIMIT 5")).rows;
      });
      assert.ok(Array.isArray(outboxResult), "abate_worker must have access only to outbox_event");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 7: Published Outbox Pruning (Section 5.5 Maintenance)
  // --------------------------------------------------------------------------
  await runTest(
    "Published outbox pruning deletes aged PUBLISHED rows while preserving pending, processing, and dead-letter events",
    async () => {
      const oldPublishedId = crypto.randomUUID();
      const recentPublishedId = crypto.randomUUID();
      const pendingId = crypto.randomUUID();
      const deadLetterId = crypto.randomUUID();
      const aggId = crypto.randomUUID();
      const eightDaysAgo = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

      // Seed events via abate_app (abate_worker has no INSERT grant on outbox_event),
      // using individual 9-parameter INSERTs for identical live-PG and memDb behavior,
      // then transition states via abate_worker.
      const seedRows: Array<[string, number]> = [
        [oldPublishedId, 1],
        [recentPublishedId, 2],
        [pendingId, 3],
        [deadLetterId, 4]
      ];
      await withTenant(tenantA, async (tx) => {
        for (const [id, ver] of seedRows) {
          await tx.q(
            `INSERT INTO outbox_event (
               id, tenant_id, aggregate, aggregate_id, aggregate_version,
               event_type, schema_version, purpose, refs
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, tenantA, "Hazard", aggId, ver, "HazardCreated", "v1", "WORKPLACE_RISK_ASSESSMENT", JSON.stringify([])]
          );
        }
      });

      await withWorker(async (tx) => {
        await tx.q(
          `UPDATE outbox_event SET state = 'PUBLISHED', published_at = $1 WHERE id = $2`,
          [eightDaysAgo, oldPublishedId]
        );
        await tx.q(
          `UPDATE outbox_event SET state = 'PUBLISHED', published_at = $1 WHERE id = $2`,
          [oneHourAgo, recentPublishedId]
        );
        await tx.q(
          `UPDATE outbox_event SET state = 'DEAD_LETTER' WHERE id = $1`,
          [deadLetterId]
        );
      });

      // Execute pruning with 7 days (168 hours) threshold
      const pruneResult = await prunePublishedOutbox(168, 500);
      assert.ok(pruneResult.prunedCount >= 1, "Pruning must remove at least the 8-day-old event");

      // Verify outcomes
      await withWorker(async (tx) => {
        const oldRow = (await tx.q("SELECT id FROM outbox_event WHERE id = $1", [oldPublishedId])).rows;
        assert.strictEqual(oldRow.length, 0, "Aged published event must be purged");

        const recentRow = (await tx.q("SELECT id FROM outbox_event WHERE id = $1", [recentPublishedId])).rows;
        assert.strictEqual(recentRow.length, 1, "Recent published event must be preserved");

        const pendingRow = (await tx.q("SELECT id FROM outbox_event WHERE id = $1", [pendingId])).rows;
        assert.strictEqual(pendingRow.length, 1, "Pending event must never be pruned");

        const deadLetterRow = (await tx.q("SELECT id FROM outbox_event WHERE id = $1", [deadLetterId])).rows;
        assert.strictEqual(deadLetterRow.length, 1, "Dead-letter event must never be pruned");

        // Assert abate_worker attempting to delete a PENDING row is refused by RLS (0 rows affected, row preserved)
        const delPendingAttempt = await tx.q("DELETE FROM outbox_event WHERE id = $1", [pendingId]);
        assert.strictEqual(delPendingAttempt.rowCount, 0, "abate_worker RLS must refuse deleting PENDING outbox rows");
        const pendingRefusedCheck = (await tx.q("SELECT id FROM outbox_event WHERE id = $1", [pendingId])).rows;
        assert.strictEqual(pendingRefusedCheck.length, 1, "Pending event must survive unauthorized delete attempt");
      });

      // Clean up remaining test rows (abate_worker RLS blocks deleting PENDING/DEAD_LETTER)
      const pgLive = await checkPgHealth();
      if (pgLive && migratorPool) {
        const cleanupClient = await migratorPool.connect();
        try {
          await cleanupClient.query("BEGIN");
          await cleanupClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
          await cleanupClient.query("DELETE FROM outbox_event WHERE id = ANY($1::uuid[])", [
            [recentPublishedId, pendingId, deadLetterId]
          ]);
          await cleanupClient.query("COMMIT");
        } finally {
          cleanupClient.release();
        }
      } else {
        await withTenant(tenantA, async (tx) => {
          await tx.q("DELETE FROM outbox_event WHERE id IN ($1, $2, $3)", [recentPublishedId, pendingId, deadLetterId]);
        });
      }
    }
  );

  // --------------------------------------------------------------------------
  // TEST 9: Scheduled Outbox Prune Pass & Worker Metrics Tracking
  // --------------------------------------------------------------------------
  await runTest(
    "Scheduled outbox prune pass updates worker prune metrics and timestamp",
    async () => {
      const agedId = crypto.randomUUID();
      const aggId = crypto.randomUUID();
      const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000).toISOString();

      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [agedId, tenantA, "Hazard", aggId, 1, "HazardCreated", "v1", "WORKPLACE_RISK_ASSESSMENT", JSON.stringify([])]
        );
      });
      await withWorker(async (tx) => {
        await tx.q(
          `UPDATE outbox_event SET state = 'PUBLISHED', published_at = $1 WHERE id = $2`,
          [tenDaysAgo, agedId]
        );
      });

      const beforeTotal = getWorkerMetrics().outboxPrunedTotal ?? 0;
      const sweep = await runScheduledOutboxPrunePass({ olderThanHours: 168, batchSize: 100 });
      assert.ok(sweep.prunedCount >= 1, "Scheduled prune sweep must purge the 10-day-old published event");
      assert.ok(sweep.executedAt, "Scheduled prune sweep must record execution timestamp");

      const afterMetrics = getWorkerMetrics();
      assert.ok(afterMetrics.lastOutboxPruneAt, "Worker metrics must expose lastOutboxPruneAt");
      assert.ok(
        (afterMetrics.outboxPrunedTotal ?? 0) >= beforeTotal + sweep.prunedCount,
        "Worker metrics must accumulate outboxPrunedTotal"
      );
    }
  );

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  const totalMs = Date.now() - startTotal;
  console.log("\n------------------------------------------------------------");
  console.log(`Worker Crash Lab Results: ${passedCount}/${reports.length} PASSED in ${totalMs}ms`);
  console.log("------------------------------------------------------------\n");

  if (passedCount !== reports.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Worker Crash Lab fatal runner error:", err);
  process.exit(1);
});
