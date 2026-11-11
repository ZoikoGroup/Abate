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
import { withTenant, withWorker, memDb } from "../src/platform/db/with-tenant";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { EventBus } from "../src/worker/outbox-publisher";
import {
  drainBatch,
  getWorkerMetrics,
  resetWorkerMetrics,
  WorkerOptions
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
            [{ kind: "org", id: aggId }]
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
            poisonRef
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
            [{ kind: "healthy_record", id: healthyAggId }]
          ]
        );
      });

      // 3. Drain attempts 1 to 4: poison event retries, attempts counter increments
      for (let attempt = 1; attempt <= 4; attempt++) {
        // Fast-forward next_retry_at to now for testing backoff transitions
        const ev = memDb.outboxEvents.find((e) => e.id === poisonId);
        if (ev) ev.next_retry_at = new Date(Date.now() - 1000).toISOString();

        await drainBatch({
          bus: testBus,
          consumerName: poisonConsumer,
          maxAttempts: 5
        });

        assert.strictEqual(ev?.attempts, attempt, `Poison event attempts must be ${attempt}`);
        assert.strictEqual(ev?.state, "PENDING", "State must remain PENDING during retry attempts");
      }

      // 4. Attempt 5: poison event must transition to DEAD_LETTER
      const ev = memDb.outboxEvents.find((e) => e.id === poisonId);
      if (ev) ev.next_retry_at = new Date(Date.now() - 1000).toISOString();

      const fifthDrain = await drainBatch({
        bus: testBus,
        consumerName: poisonConsumer,
        maxAttempts: 5
      });

      assert.strictEqual(fifthDrain.deadLetters, 1, "Fifth attempt must transition event to dead-letter");
      assert.strictEqual(ev?.state, "DEAD_LETTER", "Outbox state must be DEAD_LETTER");

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
              [{ kind: "item", index: i }]
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
          [v2Id, tenantA, "versioned_doc", targetAggId, 2, "DOC_UPDATED", "doc.v1", "Doc edit", []]
        );
      });

      // Process version 2
      const drainV2 = await drainBatch({
        bus: testBus,
        consumerName: versionConsumer
      });
      assert.strictEqual(drainV2.processed, 1, "Version 2 must process successfully");

      // 2. Queue version 1 (out-of-order)
      const v1Id = crypto.randomUUID();
      await withTenant(tenantA, async (tx) => {
        await tx.q(
          `INSERT INTO outbox_event (
             id, tenant_id, aggregate, aggregate_id, aggregate_version,
             event_type, schema_version, purpose, refs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [v1Id, tenantA, "versioned_doc", targetAggId, 1, "DOC_CREATED", "doc.v1", "Stale event", []]
        );
      });

      // Process version 1: must be detected as out-of-order and fail
      const drainV1 = await drainBatch({
        bus: testBus,
        consumerName: versionConsumer
      });
      assert.strictEqual(drainV1.failures, 1, "Out-of-order version must fail processing");

      const ev1 = memDb.outboxEvents.find((e) => e.id === v1Id);
      assert.ok(ev1?.last_error?.includes("Out-of-order event version detected"), "Error must cite out-of-order version");
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
      // 1. Worker tries to query work_fact_revision
      const factResult = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM work_fact_revision")).rows;
      });
      assert.strictEqual(
        factResult.length,
        0,
        "abate_worker MUST NOT be able to read work_fact_revision (fail-closed RLS)"
      );

      // 2. Worker tries to query principal
      const principalResult = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM principal")).rows;
      });
      assert.strictEqual(
        principalResult.length,
        0,
        "abate_worker MUST NOT be able to read principal table"
      );

      // 3. Worker tries to query organization
      const orgResult = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM organization")).rows;
      });
      assert.strictEqual(
        orgResult.length,
        0,
        "abate_worker MUST NOT be able to read organization table"
      );

      // 4. Worker CAN read outbox_event
      const outboxResult = await withWorker(async (tx) => {
        return (await tx.q("SELECT * FROM outbox_event LIMIT 5")).rows;
      });
      assert.ok(Array.isArray(outboxResult), "abate_worker must have access only to outbox_event");
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
