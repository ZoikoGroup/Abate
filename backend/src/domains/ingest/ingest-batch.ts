// backend/src/domains/ingest/ingest-batch.ts
import crypto from "node:crypto";
import { withIdentity, withProtectedCompute } from "../../platform/db/with-tenant";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { AppError } from "../../platform/errors";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { ZoikoTimeBatch } from "../../contracts/sources/zoikotime.v1";
import { CalendarCadenceBatch } from "../../contracts/sources/calendar-cadence.v1";
import { SourceAdapterName } from "../../contracts/ingest";
import { partition, partitionCalendarCadence } from "./validate";
import { derivePseudonym } from "../work/pseudonym";
import { recordKeyDigest } from "../work/record-key";
import { loadConfig } from "../../platform/config";
import { isKillSwitchActive } from "../ai/kill-switch";

const cfg = loadConfig();

const KILL_SWITCH_BY_SOURCE: Record<string, string> = {
  zoikotime: "connector:zoikotime",
  calendarcadence: "connector:calendar_cadence",
  calendar_cadence: "connector:calendar_cadence"
};

export interface IngestBatchArgs {
  who: AuthenticatedIdentity;
  actor: Actor;
  batch: ZoikoTimeBatch | CalendarCadenceBatch;
  idempotencyKey: string;
  connectorSource?: SourceAdapterName;
}

export async function ingestBatch(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  batch: ZoikoTimeBatch | CalendarCadenceBatch;
  idempotencyKey?: string;
  connectorSource?: SourceAdapterName;
}) {
  authorize(args.actor, "ingest.batch");

  const expectedSource: SourceAdapterName = args.connectorSource || "ZoikoTime";

  // Step 1: Strict Partitioning against the active connector contract. Never log raw payloads or error objects.
  const { ok, rejected } =
    expectedSource === "CalendarCadence"
      ? partitionCalendarCadence(args.batch.items)
      : partition(args.batch.items);

  const batchKey = args.idempotencyKey || args.batch.batchId;
  const requestHash = computeRequestHash({
    connectorSource: expectedSource,
    connectionId: args.batch.connectionId,
    batchId: args.batch.batchId,
    // The full item set, not just its length: the same key with different items used to replay the first
    // batch's response (silently dropping the new data) instead of returning a conflict
    items: args.batch.items
  });

  const pendingIdentityMappings: Array<{ id: string; connectionId: string; subjectRef: string; pseudonym: string }> = [];
  const pendingStaleRanges: Array<{ startUtc: string; endUtc: string }> = [];

  const cmdResult = await runCommand({
    tenantId: args.who.tenantId,
    operation: "ingest.batch",
    idempotencyKey: batchKey,
    requestHash,
    actor: args.actor,
    body: async (tx) => {
      // Step 2: Validate Connection exists, matches adapter source, kill switch is inactive, and connection is ACTIVE/RESUMED
      const connRes = await tx.q(
        `SELECT id, state, source FROM connection WHERE id = $1`,
        [args.batch.connectionId]
      );

      if (connRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Connection not found.");
      }

      const conn = connRes.rows[0];
      if (args.connectorSource && String(conn.source).toLowerCase() !== expectedSource.toLowerCase()) {
        throw new AppError(
          "VALIDATION",
          `Connection source mismatch: expected '${expectedSource}', got '${conn.source}'.`
        );
      }

      const normSource = String(conn.source || expectedSource).toLowerCase();
      const connectorScope = KILL_SWITCH_BY_SOURCE[normSource] || `connector:${normSource}`;
      if (await isKillSwitchActive(tx, connectorScope)) {
        throw new AppError("UNAVAILABLE", `Ingestion disabled by kill switch (${connectorScope}).`);
      }
      if (conn.state !== "ACTIVE" && conn.state !== "RESUMED") {
        throw new AppError("FORBIDDEN", `Connection is ${conn.state}; further data collection is blocked.`);
      }

      const receiptId = crypto.randomUUID();
      let accepted = 0;
      let duplicate = 0;
      let conflicted = 0;
      const staleSnapshotsMarked = 0;

      // Step 3a: Persist parent Ingest Receipt BEFORE inserting work_fact_revision children (FK receipt_id -> ingest_receipt.id)
      await tx.q(
        `INSERT INTO ingest_receipt (id, tenant_id, connection_id, batch_id, accepted, duplicate, rejected, conflicted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [receiptId, tx.tenantId, conn.id, args.batch.batchId, 0, 0, rejected, 0]
      );

      // Tenant secret for HMAC pseudonym derivation
      const tenantSecret = `${cfg.pseudonymSecret}:${args.who.tenantId}`;

      // Step 3b: Process validated items into work_fact_revision (identity_map & metric_snapshot use their dedicated roles after commit)
      const mappedSubjects = new Set<string>();
      for (const item of ok) {
        const itemHash = computeRequestHash(item);
        const pseudonym = derivePseudonym(tenantSecret, item.subjectRef);
        const factId = crypto.randomUUID();

        if (!mappedSubjects.has(item.subjectRef)) {
          mappedSubjects.add(item.subjectRef);
          pendingIdentityMappings.push({
            id: crypto.randomUUID(),
            connectionId: conn.id,
            subjectRef: item.subjectRef,
            pseudonym
          });
        }

        // A record purged by retention stays purged: re-delivery is a duplicate, never a resurrection
        const keyDigest = recordKeyDigest(tenantSecret, {
          connectionId: conn.id,
          sourceRecordId: item.recordId,
          revision: item.revision
        });
        const tombstoned = await tx.q(
          `SELECT record_key_digest FROM deletion_tombstone WHERE record_key_digest = $1`,
          [keyDigest]
        );
        if (tombstoned.rows.some((t: any) => t.record_key_digest === keyDigest)) {
          duplicate++;
          continue;
        }

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

          // Queue overlapping metric_snapshot invalidation for abate_protected_compute
          if (item.revision > 1) {
            pendingStaleRanges.push({ startUtc: item.startUtc, endUtc: item.endUtc });
          }
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

      // Step 4: Update Ingest Receipt counts (stores counts only, NEVER rejected payloads)
      await tx.q(
        `UPDATE ingest_receipt SET accepted = $1, duplicate = $2, conflicted = $3 WHERE id = $4`,
        [accepted, duplicate, conflicted, receiptId]
      );

      // Step 5: Advance watermark & connection success timestamp in SAME transaction
      await tx.q(
        `UPDATE connection SET last_success_at = now() WHERE id = $1`,
        [conn.id]
      );

      await tx.q(
        `INSERT INTO watermark (tenant_id, connection_id, cursor, advanced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, connection_id)
         DO UPDATE SET cursor = EXCLUDED.cursor, advanced_at = EXCLUDED.advanced_at`,
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
        staleSnapshotsMarked,
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

  if (pendingIdentityMappings.length > 0) {
    await withIdentity(args.who.tenantId, async (idTx) => {
      for (const m of pendingIdentityMappings) {
        await idTx.q(
          `INSERT INTO identity_map (id, tenant_id, connection_id, source_subject_ref, subject_pseudonym)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, connection_id, source_subject_ref) DO NOTHING`,
          [m.id, idTx.tenantId, m.connectionId, m.subjectRef, m.pseudonym]
        );
      }
    });
  }

  if (pendingStaleRanges.length > 0) {
    let marked = 0;
    await withProtectedCompute(args.who.tenantId, async (compTx) => {
      for (const rng of pendingStaleRanges) {
        const staleRes = await compTx.q(
          `UPDATE metric_snapshot SET is_stale = true
           WHERE tenant_id = $1 AND period_start <= $3 AND period_end >= $2`,
          [compTx.tenantId, rng.startUtc, rng.endUtc]
        );
        marked += (staleRes.rowCount ?? 0);
      }
    });
    if (cmdResult.body && typeof cmdResult.body === "object") {
      (cmdResult.body as any).staleSnapshotsMarked = marked;
    }
  }

  return cmdResult;
}
