// backend/src/platform/command.ts
import crypto from "node:crypto";
import { withTenant, Tx } from "./db/with-tenant";
import { AppError } from "./errors";

export interface Actor {
  principalId: string;
  tenantId: string;
  memberships: Array<{
    organization_id: string;
    domain_role: string;
  }>;
}

export interface AuditInput {
  purpose: string;
  command: string;
  resourceType: string;
  resourceId: string;
  resourceVersion?: number;
  result: "SUCCESS" | "DENIED" | "FAILED";
  evidenceRefs?: string[];
}

export interface OutboxInput {
  aggregate: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  schemaVersion: string;
  purpose: string;
  refs?: string[];
}

export function computeRequestHash(payload: any): string {
  const normalized = JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function writeAudit(tx: Tx, actor: Actor, audit: AuditInput): Promise<void> {
  await tx.q(
    `INSERT INTO audit_event (tenant_id, actor_id, purpose, command, resource_type, resource_id, resource_version, result, evidence_refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tx.tenantId,
      actor.principalId,
      audit.purpose,
      audit.command,
      audit.resourceType,
      audit.resourceId,
      audit.resourceVersion || 1,
      audit.result,
      audit.evidenceRefs || []
    ]
  );
}

async function writeOutbox(tx: Tx, event: OutboxInput): Promise<void> {
  const eventId = crypto.randomUUID();
  await tx.q(
    `INSERT INTO outbox_event (id, tenant_id, aggregate, aggregate_id, aggregate_version, event_type, schema_version, purpose, refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      eventId,
      tx.tenantId,
      event.aggregate,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      event.schemaVersion,
      event.purpose,
      event.refs || []
    ]
  );
}

/**
 * runCommand: Atomic execution pipeline providing Idempotency + Audit Log + Outbox in one transaction.
 */
export async function runCommand<T>(args: {
  tenantId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  actor: Actor;
  expectedVersion?: number;
  body: (tx: Tx) => Promise<{ result: T; audit: AuditInput; events: OutboxInput[] }>;
}): Promise<{ status: number; body: T }> {
  return withTenant(args.tenantId, async (tx) => {
    // 1. Claim the key; primary key (tenant_id, operation, idempotency_key) serializes concurrent attempts
    const claim = await tx.q(
      `INSERT INTO idempotency_record (tenant_id, operation, idempotency_key, request_hash, status)
       VALUES ($1, $2, $3, $4, 'IN_PROGRESS') ON CONFLICT DO NOTHING RETURNING 1`,
      [args.tenantId, args.operation, args.idempotencyKey, args.requestHash]
    );

    if (claim.rowCount === 0) {
      const prevRows = await tx.q(
        `SELECT request_hash, status, response_status, response_body FROM idempotency_record
         WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3 FOR UPDATE`,
        [args.tenantId, args.operation, args.idempotencyKey]
      );

      const prev = prevRows.rows[0];
      if (!prev) {
        throw new AppError("CONFLICT", "Concurrent request encountered key collision");
      }

      if (prev.request_hash !== args.requestHash) {
        throw new AppError("CONFLICT", "Idempotency key reused with different request payload");
      }

      // Exact replay: return saved result without executing domain body or emitting duplicate events
      return {
        status: prev.response_status || 200,
        body: prev.response_body as T
      };
    }

    // 2. Domain work (authorization, expected version checks, state mutation)
    const out = await args.body(tx);

    // 3. Audit + Outbox in the SAME transaction as the business mutation
    await writeAudit(tx, args.actor, out.audit);
    for (const e of out.events) {
      await writeOutbox(tx, e);
    }

    // 4. Persist the response for future retries
    await tx.q(
      `UPDATE idempotency_record SET status = 'DONE', response_status = 200, response_body = $4
       WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [args.tenantId, args.operation, args.idempotencyKey, out.result]
    );

    return { status: 200, body: out.result };
  });
}
