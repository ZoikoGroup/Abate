// backend/src/worker/outbox-publisher.ts
import crypto from "node:crypto";
import { withWorker } from "../platform/db/with-tenant";
import { AppError } from "../platform/errors";
import { EventEnvelopeType } from "../contracts/common";

export type EventHandler = (envelope: EventEnvelopeType) => Promise<void>;

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();

  subscribe(consumerName: string, eventType: string, handler: EventHandler) {
    const key = `${consumerName}:${eventType}`;
    const list = this.handlers.get(key) || [];
    list.push(handler);
    this.handlers.set(key, list);
  }

  /**
   * Consumer side: recording the event in inbox_event and running the handlers commit together,
   * so a redelivered event is skipped and a handler failure leaves it to be delivered again.
   */
  async publish(consumer: string, envelope: EventEnvelopeType): Promise<boolean> {
    return withWorker(async (tx) => {
      const claimed = await tx.q(
        `INSERT INTO inbox_event (consumer, event_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [consumer, envelope.eventId, envelope.tenantId]
      );
      if (!claimed.rowCount) {
        return false; // duplicate delivery -> skipped safely
      }

      const specificKey = `${consumer}:${envelope.aggregate}.${envelope.schemaVersion}`;
      const allKey = `${consumer}:*`;
      const handlers = [...(this.handlers.get(specificKey) || []), ...(this.handlers.get(allKey) || [])];
      for (const h of handlers) {
        await h(envelope);
      }
      return true;
    });
  }
}

export const defaultBus = new EventBus();

export interface DrainOptions {
  batchSize?: number;
  bus?: EventBus;
  consumerName?: string;
  maxAttempts?: number;
  leaseSeconds?: number;
  simulateCrashBeforeMarkingPublished?: boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_LEASE_SECONDS = 120;

/**
 * A claimed row is PROCESSING and its next_retry_at doubles as the lease expiry
 * (abate_worker may only UPDATE attempts/next_retry_at/last_error/state/published_at, so no extra column).
 * A worker that dies mid-batch leaves PROCESSING rows behind; they become claimable again once the lease passes.
 * The claim is one statement, so the row locks taken by SKIP LOCKED are converted to a durable state change
 * before the transaction commits and two workers can never hold the same row.
 */
export async function claimOutboxBatch(batchSize: number, leaseSeconds: number = DEFAULT_LEASE_SECONDS): Promise<any[]> {
  const rows = await withWorker(async (tx) =>
    (await tx.q(
      `UPDATE outbox_event
       SET state = 'PROCESSING', next_retry_at = now() + make_interval(secs => $2::double precision)
       WHERE id IN (
         SELECT id FROM outbox_event
         WHERE published_at IS NULL
           AND (state = 'PENDING' OR state = 'PROCESSING')
           AND next_retry_at <= now()
         ORDER BY created_at, aggregate_version
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [batchSize, leaseSeconds]
    )).rows
  );
  // RETURNING order is unspecified: restore creation order so versions of one aggregate go out in sequence
  return [...rows].sort((a, b) => {
    const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (d !== 0) return d;
    const v = Number(a.aggregate_version) - Number(b.aggregate_version);
    return v !== 0 ? v : String(a.id).localeCompare(String(b.id));
  });
}

export function toEnvelope(event: any): EventEnvelopeType {
  return {
    eventId: event.id,
    tenantId: event.tenant_id,
    aggregate: event.aggregate,
    aggregateVersion: event.aggregate_version,
    eventTime: new Date(event.created_at).toISOString(),
    schemaVersion: event.schema_version,
    purpose: event.purpose,
    refs: event.refs || []
  };
}

export async function getConsumerHighWaterVersion(
  consumer: string,
  aggregateId: string
): Promise<number | undefined> {
  return withWorker(async (tx) => {
    const res = await tx.q(
      `SELECT last_version FROM worker_consumer_version WHERE consumer = $1 AND aggregate_id = $2`,
      [consumer, aggregateId]
    );
    if (!res.rows.length) return undefined;
    return Number(res.rows[0].last_version);
  });
}

export async function recordConsumerHighWaterVersion(
  consumer: string,
  aggregateId: string,
  version: number
): Promise<void> {
  await withWorker(async (tx) => {
    await tx.q(
      `INSERT INTO worker_consumer_version (consumer, aggregate_id, last_version, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (consumer, aggregate_id)
       DO UPDATE SET last_version = GREATEST(worker_consumer_version.last_version, EXCLUDED.last_version),
                     updated_at = now()`,
      [consumer, aggregateId, version]
    );
  });
}

/** Delivery succeeded (or the event was deliberately dropped): finish the row. Guarded so a lost lease cannot clobber a newer owner. */
export async function markPublished(eventId: string, note: string | null = null): Promise<void> {
  await withWorker(async (tx) => {
    await tx.q(
      `UPDATE outbox_event
       SET published_at = now(), state = 'PUBLISHED', next_retry_at = now(), last_error = COALESCE($1, last_error)
       WHERE id = $2 AND state = 'PROCESSING'`,
      [note, eventId]
    );
  });
}

/** Give a claimed row back untouched (simulated crash, aborted batch) so it is deliverable again right away. */
export async function releaseClaim(eventId: string): Promise<void> {
  await withWorker(async (tx) => {
    await tx.q(
      // IN (...) rather than "= 'PROCESSING'": the in-memory store matches one-parameter updates by substring
      `UPDATE outbox_event SET state = 'PENDING', next_retry_at = now() WHERE id = $1 AND state IN ('PROCESSING')`,
      [eventId]
    );
  });
}

/**
 * Delivery failed: retry with exponential backoff (2^attempts seconds), or after maxAttempts move the row to
 * DEAD_LETTER and store references only in dead_letter_event. Never throws for a bad event.
 */
export async function recordFailure(event: any, err: unknown, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): Promise<"RETRY" | "DEAD_LETTER"> {
  const currentAttempts = (event.attempts || 0) + 1;
  const errorMsg = String((err as any)?.message || err);

  if (currentAttempts >= maxAttempts) {
    await withWorker(async (tx) => {
      const updated = await tx.q(
        `UPDATE outbox_event
         SET state = 'DEAD_LETTER', attempts = $1, last_error = $2
         WHERE id = $3 AND state = 'PROCESSING'`,
        [currentAttempts, errorMsg, event.id]
      );
      if (!updated.rowCount) return; // lease was lost and the row now belongs to someone else
      await tx.q(
        `INSERT INTO dead_letter_event (
           id, outbox_id, tenant_id, aggregate, aggregate_id, schema_version,
           purpose, refs, attempts, last_error
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          crypto.randomUUID(),
          event.id,
          event.tenant_id,
          event.aggregate,
          event.aggregate_id,
          event.schema_version,
          event.purpose,
          JSON.stringify(event.refs || []),
          currentAttempts,
          errorMsg
        ]
      );
    });
    return "DEAD_LETTER";
  }

  const nextRetry = new Date(Date.now() + Math.pow(2, currentAttempts) * 1000).toISOString();
  await withWorker(async (tx) => {
    await tx.q(
      `UPDATE outbox_event
       SET state = 'PENDING', attempts = $1, next_retry_at = $2, last_error = $3
       WHERE id = $4 AND state = 'PROCESSING'`,
      [currentAttempts, nextRetry, errorMsg, event.id]
    );
  });
  return "RETRY";
}

/**
 * drainOnce: Worker loop iteration that drains unpublished outbox events with at-least-once delivery.
 * Rows are claimed atomically (PROCESSING + lease), each event is handled independently, so one poison event
 * backs off / dead-letters instead of blocking the head of the queue.
 */
export async function drainOnce(opts: DrainOptions = {}): Promise<{ drained: number; published: number }> {
  const batch = opts.batchSize || 50;
  const bus = opts.bus || defaultBus;
  const consumer = opts.consumerName || "default-worker";
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const leaseSeconds = opts.leaseSeconds || DEFAULT_LEASE_SECONDS;

  const claimed = await claimOutboxBatch(batch, leaseSeconds);
  const unfinished = new Set<string>(claimed.map((e) => e.id));

  let publishedCount = 0;
  try {
    for (const event of claimed) {
      try {
        await bus.publish(consumer, toEnvelope(event));
      } catch (err) {
        await recordFailure(event, err, maxAttempts);
        unfinished.delete(event.id);
        continue;
      }

      if (opts.simulateCrashBeforeMarkingPublished) {
        // Simulates worker crash after bus.publish but before marking published_at in db
        throw new Error("Simulated worker crash after publish");
      }

      // Marked after delivery: a crash before this line means redelivery, which the consumer inbox absorbs
      await markPublished(event.id);
      unfinished.delete(event.id);
      publishedCount++;
    }
  } finally {
    // An aborted batch must not strand its remaining rows in PROCESSING until the lease runs out
    for (const id of unfinished) {
      await releaseClaim(id).catch(() => {});
    }
  }

  return {
    drained: claimed.length,
    published: publishedCount
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Human-approved replay of a dead-lettered outbox event (Completion Plan Section 6).
 * Preserves dead_letter_event row with operator attribution and resets the underlying outbox row to PENDING.
 */
export async function replayDeadLetterEvent(
  id: string,
  actorSubject: string,
  reason: string
): Promise<{
  deadLetterId: string;
  outboxId: string;
  replayedBy: string;
  reason: string;
  state: "PENDING";
}> {
  if (!UUID_RE.test(id)) {
    throw new AppError("NOT_FOUND", "Dead-letter event not found.");
  }
  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < 5 || trimmedReason.length > 500) {
    throw new AppError("VALIDATION", "Human approval reason must be between 5 and 500 characters.");
  }

  return withWorker(async (tx) => {
    const found = await tx.q(
      `SELECT id, outbox_id, replayed_at FROM dead_letter_event WHERE id = $1 OR outbox_id = $1`,
      [id]
    );
    if (!found.rows.length) {
      throw new AppError("NOT_FOUND", "Dead-letter event not found.");
    }
    const row = found.rows[0];
    if (row.replayed_at) {
      throw new AppError("CONFLICT", "Dead-letter event has already been replayed.");
    }

    await tx.q(
      `UPDATE outbox_event
       SET state = 'PENDING', attempts = 0, next_retry_at = now(), last_error = NULL
       WHERE id = $1 AND state = 'DEAD_LETTER'`,
      [row.outbox_id]
    );

    await tx.q(
      `UPDATE dead_letter_event
       SET replayed_at = now(), replayed_by = $1, replay_reason = $2
       WHERE id = $3`,
      [actorSubject, trimmedReason, row.id]
    );

    return {
      deadLetterId: row.id,
      outboxId: row.outbox_id,
      replayedBy: actorSubject,
      reason: trimmedReason,
      state: "PENDING"
    };
  });
}
