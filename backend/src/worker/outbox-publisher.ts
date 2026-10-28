// backend/src/worker/outbox-publisher.ts
import { appPool, memDb } from "../platform/db/with-tenant";
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

  async publish(consumer: string, envelope: EventEnvelopeType): Promise<boolean> {
    // Consumer deduplication via inbox_event table
    const inboxKey = `${consumer}:${envelope.eventId}`;
    if (memDb.inboxEvents.has(inboxKey)) {
      // Duplicate delivery -> skipped safely
      return false;
    }

    memDb.inboxEvents.set(inboxKey, {
      consumer,
      event_id: envelope.eventId,
      tenant_id: envelope.tenantId,
      received_at: new Date().toISOString()
    });

    const specificKey = `${consumer}:${envelope.aggregate}.${envelope.schemaVersion}`;
    const allKey = `${consumer}:*`;
    const handlers = [...(this.handlers.get(specificKey) || []), ...(this.handlers.get(allKey) || [])];

    for (const h of handlers) {
      await h(envelope);
    }
    return true;
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

  let unpublished = memDb.outboxEvents.filter(e => !e.published_at).slice(0, batch);

  let publishedCount = 0;
  for (const event of unpublished) {
    const envelope: EventEnvelopeType = {
      eventId: event.id,
      tenantId: event.tenant_id,
      aggregate: event.aggregate,
      aggregateVersion: event.aggregate_version,
      eventTime: event.created_at,
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

    event.published_at = new Date().toISOString();
    publishedCount++;
  }

  return {
    drained: unpublished.length,
    published: publishedCount
  };
}

