// backend/src/worker/outbox-publisher.ts
import crypto from "node:crypto";
import { withWorker } from "../platform/db/with-tenant";
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

/** Delivery succeeded (or the event was deliberately dropped): finish the row. Guarded so a lost lease cannot clobber a newer owner. */
export async function markPublished(eventId: string, note: string | null = null): Promise<void> {
  await withWorker(async (tx) => {
    await tx.q(
      `UPDATE outbox_event
       SET published_at = now(), state = 'PUBLISHED', last_error = COALESCE($1, last_error)
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
