// backend/src/worker/outbox-publisher.ts
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
  simulateCrashBeforeMarkingPublished?: boolean;
}

/**
 * drainOnce: Worker loop iteration that drains unpublished outbox events with at-least-once delivery.
 */
export async function drainOnce(opts: DrainOptions = {}): Promise<{ drained: number; published: number }> {
  const batch = opts.batchSize || 50;
  const bus = opts.bus || defaultBus;
  const consumer = opts.consumerName || "default-worker";

  const unpublished = await withWorker(async (tx) =>
    (await tx.q(
      `SELECT * FROM outbox_event WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
      [batch]
    )).rows
  );

  let publishedCount = 0;
  for (const event of unpublished) {
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

    // Publish to event bus / downstream consumer
    await bus.publish(consumer, envelope);

    if (opts.simulateCrashBeforeMarkingPublished) {
      // Simulates worker crash after bus.publish but before marking published_at in db
      throw new Error("Simulated worker crash after publish");
    }

    // Marked after delivery: a crash before this line means redelivery, which the consumer inbox absorbs
    await withWorker(tx => tx.q(`UPDATE outbox_event SET published_at = now() WHERE id = $1`, [event.id]));
    publishedCount++;
  }

  return {
    drained: unpublished.length,
    published: publishedCount
  };
}
