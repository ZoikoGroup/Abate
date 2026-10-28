// backend/src/domains/ingest/ingest-batch.ts
import crypto from "node:crypto";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { AppError } from "../../platform/errors";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { ZoikoTimeBatch } from "../../contracts/sources/zoikotime.v1";
import { partition } from "./validate";
import { derivePseudonym } from "../work/pseudonym";
import { loadConfig } from "../../platform/config";

const cfg = loadConfig();

export interface IngestBatchArgs {
  who: AuthenticatedIdentity;
  actor: Actor;
  batch: ZoikoTimeBatch;
  idempotencyKey: string;
}

export async function ingestBatch(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  batch: ZoikoTimeBatch;
  idempotencyKey?: string;
}) {
  authorize(args.actor, "ingest.batch");

  // Step 1: Strict Partitioning. Never log raw payloads or error objects.
  const { ok, rejected } = partition(args.batch.items);

  const batchKey = args.idempotencyKey || args.batch.batchId;
  const requestHash = computeRequestHash({
    connectionId: args.batch.connectionId,
    batchId: args.batch.batchId,
    itemCount: args.batch.items.length
  });

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "ingest.batch",
    idempotencyKey: batchKey,
    requestHash,
    actor: args.actor,
    body: async (tx) => {
      // Step 2: Validate Connection exists and is ACTIVE
      const connRes = await tx.q(
        `SELECT id, state FROM connection WHERE id = $1`,
        [args.batch.connectionId]
      );

      if (connRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Connection not found.");
      }

      const conn = connRes.rows[0];
      if (conn.state !== "ACTIVE") {
        throw new AppError("FORBIDDEN", `Connection is ${conn.state}; further data collection is blocked.`);
      }

      const receiptId = crypto.randomUUID();
      let accepted = 0;
      let duplicate = 0;
      let conflicted = 0;

      // Tenant secret for HMAC pseudonym derivation
      const tenantSecret = `${cfg.authSecret}:${args.who.tenantId}`;

      // Step 3: Process validated items into work_fact_revision
      for (const item of ok) {
        const itemHash = computeRequestHash(item);
        const pseudonym = derivePseudonym(tenantSecret, item.subjectRef);
        const factId = crypto.randomUUID();

        const insRes = await tx.q(
          `INSERT INTO work_fact_revision (
            id, tenant_id, connection_id, source_record_id, revision,
            subject_pseudonym, start_at, end_at, work_tz, kind, payload_hash, receipt_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (tenant_id, connection_id, source_record_id, revision) DO NOTHING RETURNING 1`,
          [
            factId,
            tx.tenantId,
            conn.id,
            item.recordId,
            item.revision,
            pseudonym,
            item.startUtc,
            item.endUtc,
            item.workTz,
            item.kind,
            itemHash,
            receiptId
          ]
        );

        if (insRes.rowCount === 1) {
          accepted++;
        } else {
          // Check if it's an exact duplicate or payload conflict
          const prevRows = await tx.q(
            `SELECT payload_hash FROM work_fact_revision
             WHERE tenant_id = $1 AND connection_id = $2 AND source_record_id = $3 AND revision = $4`,
            [tx.tenantId, conn.id, item.recordId, item.revision]
          );

          if ((prevRows.rowCount ?? 0) > 0 && prevRows.rows[0].payload_hash === itemHash) {
            duplicate++;
          } else {
            conflicted++;
          }
        }
      }

      // Step 4: Persist traceable Ingest Receipt (stores counts only, NEVER rejected payloads)
      await tx.q(
        `INSERT INTO ingest_receipt (id, tenant_id, connection_id, batch_id, accepted, duplicate, rejected, conflicted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [receiptId, tx.tenantId, conn.id, args.batch.batchId, accepted, duplicate, rejected, conflicted]
      );

      // Step 5: Advance watermark & connection success timestamp in SAME transaction
      await tx.q(
        `UPDATE connection SET last_success_at = now() WHERE id = $1`,
        [conn.id]
      );

      await tx.q(
        `INSERT INTO watermark (tenant_id, connection_id, cursor, advanced_at)
         VALUES ($1, $2, $3, now())`,
        [tx.tenantId, conn.id, args.batch.batchId]
      );

      const result = {
        receiptId,
        connectionId: conn.id,
        batchId: args.batch.batchId,
        accepted,
        duplicate,
        rejected,
        conflicted,
        recordedAt: new Date().toISOString()
      };

      const audit = {
        purpose: args.who.purpose,
        command: "ingest.batch",
        resourceType: "ingest_receipt",
        resourceId: receiptId,
        resourceVersion: 1,
        result: "SUCCESS" as const,
        evidenceRefs: [`receipt/${receiptId}`, `batch/${args.batch.batchId}`]
      };

      const events = [
        {
          aggregate: "work_facts",
          aggregateId: receiptId,
          aggregateVersion: 1,
          eventType: "work.facts.changed",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`receipt/${receiptId}`, `connection/${conn.id}`]
        }
      ];

      return { result, audit, events };
    }
  });
}
