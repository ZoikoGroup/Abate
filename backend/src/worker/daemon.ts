// backend/src/worker/daemon.ts
// Module 1 / Step 2: Resilient Worker Daemon with FOR UPDATE SKIP LOCKED,
// Exponential Backoff Retries, Dead-Letter Isolation, and Consumer Invariant Deduplication.
// Role: abate_worker (cross-tenant access to outbox_event, inbox_event, and dead_letter_event).

import {
  EventBus,
  defaultBus,
  claimOutboxBatch,
  toEnvelope,
  markPublished,
  releaseClaim,
  recordFailure,
  getConsumerHighWaterVersion,
  recordConsumerHighWaterVersion,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LEASE_SECONDS,
  prunePublishedOutbox
} from "./outbox-publisher";
import { runScheduledRetentionPass } from "./retention-executor";

export interface WorkerMetrics {
  workerId: string;
  state: "STOPPED" | "RUNNING" | "STOPPING";
  heartbeatAt: string | null;
  queueDepth: number;
  queueLagMs: number;
  totalProcessed: number;
  totalFailures: number;
  totalDeadLetters: number;
  lastError: string | null;
  lastRunAt: string | null;
  lastRetentionRunAt?: string | null;
  retentionPurgedTotal?: number;
  lastOutboxPruneAt?: string | null;
  outboxPrunedTotal?: number;
}

export interface WorkerOptions {
  workerId?: string;
  batchSize?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  maxAttempts?: number;
  leaseSeconds?: number;
  bus?: EventBus;
  consumerName?: string;
  simulateCrashAfterPublish?: boolean;
  enableRetentionExecutor?: boolean;
  retentionIntervalMs?: number;
  enableOutboxPrune?: boolean;
  outboxPruneIntervalMs?: number;
  outboxPruneOlderThanHours?: number;
}

// Global live metrics state for operations dashboard and health endpoints
const globalMetrics: WorkerMetrics = {
  workerId: "worker-daemon-primary",
  state: "STOPPED",
  heartbeatAt: null,
  queueDepth: 0,
  queueLagMs: 0,
  totalProcessed: 0,
  totalFailures: 0,
  totalDeadLetters: 0,
  lastError: null,
  lastRunAt: null,
  lastRetentionRunAt: null,
  retentionPurgedTotal: 0,
  lastOutboxPruneAt: null,
  outboxPrunedTotal: 0
};

export function getWorkerMetrics(): WorkerMetrics {
  return { ...globalMetrics };
}

export function resetWorkerMetrics(): void {
  globalMetrics.totalProcessed = 0;
  globalMetrics.totalFailures = 0;
  globalMetrics.totalDeadLetters = 0;
  globalMetrics.lastError = null;
  globalMetrics.heartbeatAt = null;
  globalMetrics.queueDepth = 0;
  globalMetrics.queueLagMs = 0;
  globalMetrics.lastOutboxPruneAt = null;
  globalMetrics.outboxPrunedTotal = 0;
}

/**
 * Executes a scheduled published-outbox pruning sweep and updates worker metrics.
 */
export async function runScheduledOutboxPrunePass(opts: {
  olderThanHours?: number;
  batchSize?: number;
} = {}): Promise<{ prunedCount: number; olderThanHours: number; executedAt: string }> {
  const olderThanHours = opts.olderThanHours ?? 168;
  const batchSize = opts.batchSize ?? 500;
  const res = await prunePublishedOutbox(olderThanHours, batchSize);
  const executedAt = new Date().toISOString();
  globalMetrics.lastOutboxPruneAt = executedAt;
  globalMetrics.outboxPrunedTotal = (globalMetrics.outboxPrunedTotal || 0) + res.prunedCount;
  return { ...res, executedAt };
}

/**
 * Single batch drain iteration: atomic claim (PROCESSING + lease), retries, and dead-letter protection.
 */
export async function drainBatch(opts: WorkerOptions = {}): Promise<{
  processed: number;
  failures: number;
  deadLetters: number;
  skipped: number;
  queueLagMs: number;
}> {
  const batchSize = opts.batchSize || 25;
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const leaseSeconds = opts.leaseSeconds || DEFAULT_LEASE_SECONDS;
  const bus = opts.bus || defaultBus;
  const consumer = opts.consumerName || "abate_worker";

  globalMetrics.heartbeatAt = new Date().toISOString();
  globalMetrics.lastRunAt = new Date().toISOString();

  // 1. Claim eligible events in a single statement (SELECT ... FOR UPDATE SKIP LOCKED inside UPDATE ... RETURNING).
  //    The rows are durably PROCESSING when the claim commits, so no other worker can take them while we deliver.
  const claimedAt = Date.now();
  const eligibleEvents = await claimOutboxBatch(batchSize, leaseSeconds);

  if (eligibleEvents.length === 0) {
    globalMetrics.queueDepth = 0;
    globalMetrics.queueLagMs = 0;
    return { processed: 0, failures: 0, deadLetters: 0, skipped: 0, queueLagMs: 0 };
  }

  // Calculate queue lag: time since the oldest pending event was created
  const oldestTime = new Date(eligibleEvents[0].created_at).getTime();
  const queueLagMs = Math.max(0, Date.now() - oldestTime);
  globalMetrics.queueDepth = eligibleEvents.length;
  globalMetrics.queueLagMs = queueLagMs;

  let processed = 0;
  let failures = 0;
  let deadLetters = 0;
  let skipped = 0;

  // Rows we still own; anything left here when the batch aborts is handed back instead of waiting out the lease
  const unfinished = new Set<string>(eligibleEvents.map((e) => e.id));

  try {
    for (const event of eligibleEvents) {
      // Our lease on the rest of the batch has run out: another worker may already have reclaimed them
      if (Date.now() >= claimedAt + leaseSeconds * 1000) break;

      try {
        // Durable stale-version detection backed by worker_consumer_version (survives worker restarts).
        // Only an event STRICTLY older than a version this consumer already took for the same aggregate is stale.
        const lastVer = await getConsumerHighWaterVersion(consumer, event.aggregate_id);
        if (lastVer !== undefined && Number(event.aggregate_version) < lastVer) {
          // Drop (do not retry, do not dead-letter): delivering it now would move the consumer backwards
          await markPublished(
            event.id,
            `Skipped stale event version: received version ${event.aggregate_version} but aggregate ${event.aggregate_id} is already at version ${lastVer}`
          );
          unfinished.delete(event.id);
          skipped++;
          continue;
        }

        // Step A: Publish to downstream consumer / event bus
        await bus.publish(consumer, toEnvelope(event));

        // Simulated crash hook for testing at-least-once idempotency
        if (opts.simulateCrashAfterPublish) {
          throw new Error("SIMULATED_WORKER_CRASH_AFTER_PUBLISH");
        }

        // Persist consumer version advancement durably only on un-crashed delivery
        await recordConsumerHighWaterVersion(consumer, event.aggregate_id, Number(event.aggregate_version));

        // Step B: Mark event as published
        await markPublished(event.id);
        unfinished.delete(event.id);

        processed++;
        globalMetrics.totalProcessed++;
      } catch (err: any) {
        if (err.message === "SIMULATED_WORKER_CRASH_AFTER_PUBLISH") {
          // Simulates a crash: lease is given back, batch aborts (remaining rows released in finally)
          throw err;
        }

        failures++;
        globalMetrics.totalFailures++;
        globalMetrics.lastError = String(err.message || err);

        const outcome = await recordFailure(event, err, maxAttempts);
        unfinished.delete(event.id);
        if (outcome === "DEAD_LETTER") {
          deadLetters++;
          globalMetrics.totalDeadLetters++;
        }
      }
    }
  } finally {
    for (const id of unfinished) {
      await releaseClaim(id).catch(() => { });
    }
  }

  return { processed, failures, deadLetters, skipped, queueLagMs };
}

let daemonRunning = false;
let stopRequested = false;

/**
 * Long-running daemon polling loop with adaptive backoff (100ms - 5000ms).
 */
export async function runWorkerDaemon(opts: WorkerOptions = {}): Promise<void> {
  const minIntervalMs = opts.minIntervalMs || 100;
  const maxIntervalMs = opts.maxIntervalMs || 5000;
  const retentionIntervalMs = opts.retentionIntervalMs || 3_600_000;
  const outboxPruneIntervalMs = opts.outboxPruneIntervalMs || 6 * 3_600_000;
  let lastRetentionTick = 0;
  let lastOutboxPruneTick = 0;
  let currentDelay = minIntervalMs;

  daemonRunning = true;
  stopRequested = false;
  globalMetrics.state = "RUNNING";
  globalMetrics.workerId = opts.workerId || globalMetrics.workerId;

  // Signal handlers for graceful shutdown
  const onSignal = () => {
    stopRequested = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    while (!stopRequested) {
      try {
        const result = await drainBatch(opts);

        if (opts.enableRetentionExecutor && Date.now() - lastRetentionTick >= retentionIntervalMs) {
          lastRetentionTick = Date.now();
          const retSummary = await runScheduledRetentionPass();
          globalMetrics.lastRetentionRunAt = retSummary.executedAt;
          globalMetrics.retentionPurgedTotal = (globalMetrics.retentionPurgedTotal || 0) + retSummary.totalPurged;
        }

        if (opts.enableOutboxPrune && Date.now() - lastOutboxPruneTick >= outboxPruneIntervalMs) {
          lastOutboxPruneTick = Date.now();
          await runScheduledOutboxPrunePass({
            olderThanHours: opts.outboxPruneOlderThanHours
          });
        }

        if (result.processed > 0) {
          // If work was found and processed, poll immediately with minimal backoff
          currentDelay = minIntervalMs;
        } else {
          // Queue empty: back off smoothly up to maxIntervalMs (5000ms)
          currentDelay = Math.min(currentDelay * 1.5, maxIntervalMs);
        }
      } catch (loopErr: any) {
        globalMetrics.lastError = loopErr?.message || String(loopErr);
        currentDelay = Math.min(currentDelay * 2, maxIntervalMs);
      }

      if (stopRequested) break;
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    daemonRunning = false;
    globalMetrics.state = "STOPPED";
  }
}

export async function stopWorkerDaemon(): Promise<void> {
  stopRequested = true;
  let waitCount = 0;
  while (daemonRunning && waitCount < 20) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    waitCount++;
  }
}

// Direct CLI entrypoint: tsx src/worker/daemon.ts or node dist/worker/daemon.js
if (typeof process !== "undefined" && /daemon\.(ts|js)$/.test(process.argv[1] || "")) {
  const enableRetentionExecutor =
    process.env.ABATE_ENABLE_RETENTION_EXECUTOR === "1" ||
    process.env.ABATE_ENABLE_RETENTION_EXECUTOR === "true";
  const parsedInterval = Number(process.env.ABATE_RETENTION_INTERVAL_MS);
  const retentionIntervalMs = Number.isFinite(parsedInterval) && parsedInterval >= 1000 ? parsedInterval : undefined;

  const enableOutboxPrune =
    process.env.ABATE_ENABLE_OUTBOX_PRUNE === "1" ||
    process.env.ABATE_ENABLE_OUTBOX_PRUNE === "true";
  const parsedPruneInterval = Number(process.env.ABATE_OUTBOX_PRUNE_INTERVAL_MS);
  const outboxPruneIntervalMs = Number.isFinite(parsedPruneInterval) && parsedPruneInterval >= 1000 ? parsedPruneInterval : undefined;
  const parsedPruneHours = Number(process.env.ABATE_OUTBOX_PRUNE_HOURS);
  const outboxPruneOlderThanHours = Number.isFinite(parsedPruneHours) && parsedPruneHours >= 1 ? parsedPruneHours : undefined;

  runWorkerDaemon({
    enableRetentionExecutor,
    retentionIntervalMs,
    enableOutboxPrune,
    outboxPruneIntervalMs,
    outboxPruneOlderThanHours
  }).catch((err) => {
    console.error("Worker daemon fatal error:", err);
    process.exit(1);
  });
}
