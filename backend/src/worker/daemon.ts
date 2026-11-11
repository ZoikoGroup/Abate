// backend/src/worker/daemon.ts
// Module 1 / Step 2: Resilient Worker Daemon with FOR UPDATE SKIP LOCKED,
// Exponential Backoff Retries, Dead-Letter Isolation, and Consumer Invariant Deduplication.
// Role: abate_worker (cross-tenant access to outbox_event, inbox_event, and dead_letter_event).

import crypto from "node:crypto";
import { withWorker } from "../platform/db/with-tenant";
import { EventEnvelopeType } from "../contracts/common";
import { EventBus, defaultBus } from "./outbox-publisher";

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
}

export interface WorkerOptions {
  workerId?: string;
  batchSize?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  maxAttempts?: number;
  bus?: EventBus;
  consumerName?: string;
  simulateCrashAfterPublish?: boolean;
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
  lastRunAt: null
};

// In-memory consumer version map to detect out-of-order versions: aggregate_id -> last_version
const consumerVersionMap = new Map<string, number>();

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
  consumerVersionMap.clear();
}

/**
 * Single batch drain iteration with SKIP LOCKED, retries, and dead-letter protection.
 */
export async function drainBatch(opts: WorkerOptions = {}): Promise<{
  processed: number;
  failures: number;
  deadLetters: number;
  queueLagMs: number;
}> {
  const batchSize = opts.batchSize || 25;
  const maxAttempts = opts.maxAttempts || 5;
  const bus = opts.bus || defaultBus;
  const consumer = opts.consumerName || "abate_worker";

  globalMetrics.heartbeatAt = new Date().toISOString();
  globalMetrics.lastRunAt = new Date().toISOString();

  // 1. Fetch unpublished events eligible for processing using FOR UPDATE SKIP LOCKED
  const eligibleEvents = await withWorker(async (tx) => {
    const res = await tx.q(
      `SELECT * FROM outbox_event 
       WHERE (published_at IS NULL)
         AND (state = 'PENDING' OR state IS NULL)
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    return res.rows;
  });

  if (eligibleEvents.length === 0) {
    globalMetrics.queueDepth = 0;
    globalMetrics.queueLagMs = 0;
    return { processed: 0, failures: 0, deadLetters: 0, queueLagMs: 0 };
  }

  // Calculate queue lag: time since the oldest pending event was created
  const oldestTime = new Date(eligibleEvents[0].created_at).getTime();
  const queueLagMs = Math.max(0, Date.now() - oldestTime);
  globalMetrics.queueDepth = eligibleEvents.length;
  globalMetrics.queueLagMs = queueLagMs;

  let processed = 0;
  let failures = 0;
  let deadLetters = 0;

  for (const event of eligibleEvents) {
    const envelope: EventEnvelopeType = {
      eventId: event.id,
      tenantId: event.tenant_id,
      aggregate: event.aggregate,
      aggregateVersion: event.aggregate_version,
      eventTime: new Date(event.created_at).toISOString(),
      schemaVersion: event.schema_version,
      purpose: event.purpose,
      refs: event.refs || []
    };

    try {
      // Out-of-order version detection
      const lastVer = consumerVersionMap.get(event.aggregate_id);
      if (lastVer !== undefined && event.aggregate_version <= lastVer) {
        // Out-of-order version detected
        throw new Error(
          `Out-of-order event version detected: received version ${event.aggregate_version} but aggregate ${event.aggregate_id} is already at version ${lastVer}`
        );
      }

      // Step A: Publish to downstream consumer / event bus
      await bus.publish(consumer, envelope);

      // Simulated crash hook for testing at-least-once idempotency
      if (opts.simulateCrashAfterPublish) {
        throw new Error("SIMULATED_WORKER_CRASH_AFTER_PUBLISH");
      }

      // Record consumer version advancement only on un-crashed delivery
      consumerVersionMap.set(event.aggregate_id, event.aggregate_version);

      // Step B: Mark event as published in atomic worker transaction
      await withWorker(async (tx) => {
        await tx.q(
          `UPDATE outbox_event 
           SET published_at = now(), state = 'PUBLISHED' 
           WHERE id = $1`,
          [event.id]
        );
      });

      processed++;
      globalMetrics.totalProcessed++;
    } catch (err: any) {
      if (err.message === "SIMULATED_WORKER_CRASH_AFTER_PUBLISH") {
        // Simulates PostgreSQL releasing transaction lock on worker crash
        await withWorker(async (tx) => {
          await tx.q(
            `UPDATE outbox_event SET state = 'PENDING' WHERE id = $1`,
            [event.id]
          );
        });
        throw err;
      }

      failures++;
      globalMetrics.totalFailures++;
      const currentAttempts = (event.attempts || 0) + 1;
      const errorMsg = String(err.message || err);
      globalMetrics.lastError = errorMsg;

      if (currentAttempts >= maxAttempts) {
        // Exceeded 5 attempts -> transition to DEAD_LETTER without blocking queue
        deadLetters++;
        globalMetrics.totalDeadLetters++;

        await withWorker(async (tx) => {
          // 1. Move to dead_letter_event storing REFERENCES ONLY, NEVER PAYLOAD
          const deadLetterId = crypto.randomUUID();
          await tx.q(
            `INSERT INTO dead_letter_event (
               id, outbox_id, tenant_id, aggregate, aggregate_id, schema_version,
               purpose, refs, attempts, last_error
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              deadLetterId,
              event.id,
              event.tenant_id,
              event.aggregate,
              event.aggregate_id,
              event.schema_version,
              event.purpose,
              event.refs || [],
              currentAttempts,
              errorMsg
            ]
          );

          // 2. Mark outbox_event as DEAD_LETTER
          await tx.q(
            `UPDATE outbox_event 
             SET state = 'DEAD_LETTER', attempts = $1, last_error = $2 
             WHERE id = $3`,
            [currentAttempts, errorMsg, event.id]
          );
        });
      } else {
        // Exponential backoff for retry: 2^attempts seconds
        const backoffSeconds = Math.pow(2, currentAttempts);
        const nextRetry = new Date(Date.now() + backoffSeconds * 1000).toISOString();

        await withWorker(async (tx) => {
          await tx.q(
            `UPDATE outbox_event 
             SET state = 'PENDING', attempts = $1, next_retry_at = $2, last_error = $3 
             WHERE id = $4`,
            [currentAttempts, nextRetry, errorMsg, event.id]
          );
        });
      }
    }
  }

  return { processed, failures, deadLetters, queueLagMs };
}

let daemonRunning = false;
let stopRequested = false;

/**
 * Long-running daemon polling loop with adaptive backoff (100ms - 5000ms).
 */
export async function runWorkerDaemon(opts: WorkerOptions = {}): Promise<void> {
  const minIntervalMs = opts.minIntervalMs || 100;
  const maxIntervalMs = opts.maxIntervalMs || 5000;
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

// Direct CLI entrypoint: tsx src/worker/daemon.ts
if (typeof process !== "undefined" && process.argv[1]?.includes("daemon.ts")) {
  runWorkerDaemon().catch((err) => {
    console.error("Worker daemon fatal error:", err);
    process.exit(1);
  });
}
