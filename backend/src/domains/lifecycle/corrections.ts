// backend/src/domains/lifecycle/corrections.ts
import crypto from "node:crypto";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { AppError } from "../../platform/errors";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import {
  CorrectionInput,
  CorrectionInputSchema,
  AcknowledgeCorrectionInput,
  AcknowledgeCorrectionInputSchema
} from "../../contracts/governance";

export interface CorrectionRecord {
  id: string;
  tenantId: string;
  connectionId: string;
  sourceRecordId: string;
  revision: number;
  affectedStart: string;
  affectedEnd: string;
  impactedReleases: string[];
  impactedPackages: string[];
  status: "STALE_MARKED" | "ACKNOWLEDGED";
  recordedAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  reviewerNotes: string | null;
}

const ms = (d: string | Date) => new Date(d).getTime();
const iso = (d: string | Date | null) => (d === null ? null : new Date(d).toISOString());
const asArray = (v: unknown): string[] => (typeof v === "string" ? JSON.parse(v) : (v as string[]) ?? []);

function toView(r: any): CorrectionRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    sourceRecordId: r.source_record_id,
    revision: r.revision,
    affectedStart: iso(r.affected_start)!,
    affectedEnd: iso(r.affected_end)!,
    impactedReleases: asArray(r.impacted_releases),
    impactedPackages: asArray(r.impacted_packages),
    status: r.status,
    recordedAt: iso(r.recorded_at)!,
    acknowledgedBy: r.acknowledged_by ?? null,
    acknowledgedAt: iso(r.acknowledged_at ?? null),
    reviewerNotes: r.reviewer_notes ?? null
  };
}

/**
 * Late correction (Playbook B5 §3 Step 8). The corrected revision must already be in the ledger.
 * Only what the correction can actually affect is marked: releases whose period overlaps any revision of
 * the record become STALE, and issued evidence packages containing those releases are SUPERSEDED.
 * History is not rewritten: original cutoffs and artifacts stay as they were.
 */
export async function recordCorrection(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  input: CorrectionInput;
  idempotencyKey: string | null | undefined;
}) {
  authorize(args.actor, "correction.record");
  const input = CorrectionInputSchema.parse(args.input);
  if (!args.idempotencyKey) {
    throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
  }

  return runCommand<CorrectionRecord>({
    tenantId: args.who.tenantId,
    operation: "correction.record",
    idempotencyKey: args.idempotencyKey,
    requestHash: computeRequestHash(input),
    actor: args.actor,
    body: async (tx) => {
      const revisions = (await tx.q("SELECT * FROM work_fact_revision")).rows
        .filter((f: any) => f.connection_id === input.connectionId && f.source_record_id === input.sourceRecordId);
      if (revisions.length === 0) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      if (!revisions.some((f: any) => f.revision === input.revision)) {
        throw new AppError("VALIDATION", `Revision ${input.revision} of this record is not in the ledger.`);
      }

      // Old and new intervals are both affected: a release over either may now be wrong
      const affectedStart = Math.min(...revisions.map((f: any) => ms(f.start_at)));
      const affectedEnd = Math.max(...revisions.map((f: any) => ms(f.end_at)));

      const overlapping = new Set(
        (await tx.q("SELECT * FROM released_artifact")).rows
          .filter((a: any) => ms(a.period_start) < affectedEnd && ms(a.period_end) > affectedStart)
          .map((a: any) => a.release_id)
      );
      const impactedReleases = (await tx.q("SELECT * FROM privacy_release")).rows
        .filter((r: any) => r.status === "RELEASED" && overlapping.has(r.id))
        .map((r: any) => r.id as string);
      for (const id of impactedReleases) {
        await tx.q("UPDATE privacy_release SET status = $1 WHERE id = $2", ["STALE", id]);
      }

      const impacted = new Set(impactedReleases);
      const packageIds = new Set(
        (await tx.q("SELECT * FROM evidence_item")).rows
          .filter((i: any) => i.item_type === "released_artifact" && impacted.has(i.item_id))
          .map((i: any) => i.package_id)
      );
      const impactedPackages = (await tx.q("SELECT * FROM evidence_package")).rows
        .filter((p: any) => p.state === "ISSUED" && packageIds.has(p.id))
        .map((p: any) => p.id as string);
      for (const id of impactedPackages) {
        await tx.q("UPDATE evidence_package SET state = $1 WHERE id = $2", ["SUPERSEDED", id]);
      }

      const row = {
        id: crypto.randomUUID(),
        tenant_id: tx.tenantId,
        connection_id: input.connectionId,
        source_record_id: input.sourceRecordId,
        revision: input.revision,
        affected_start: new Date(affectedStart).toISOString(),
        affected_end: new Date(affectedEnd).toISOString(),
        impacted_releases: impactedReleases,
        impacted_packages: impactedPackages,
        status: "STALE_MARKED",
        recorded_by: args.actor.principalId,
        recorded_at: new Date().toISOString()
      };
      await tx.q(
        `INSERT INTO correction (
          id, tenant_id, connection_id, source_record_id, revision, affected_start, affected_end,
          impacted_releases, impacted_packages, status, recorded_by, recorded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'STALE_MARKED', $10, $11)`,
        [
          row.id, row.tenant_id, row.connection_id, row.source_record_id, row.revision, row.affected_start, row.affected_end,
          JSON.stringify(impactedReleases), JSON.stringify(impactedPackages), row.recorded_by, row.recorded_at
        ]
      );

      return {
        result: toView(row),
        audit: {
          purpose: args.who.purpose,
          command: "correction.record",
          resourceType: "correction",
          resourceId: row.id,
          result: "SUCCESS" as const,
          evidenceRefs: [`correction/${row.id}`, ...impactedReleases.map(r => `release/${r}`)]
        },
        events: [{
          aggregate: "correction",
          aggregateId: row.id,
          aggregateVersion: 1,
          eventType: "correction.recorded",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`correction/${row.id}`]
        }]
      };
    }
  });
}

/**
 * Reviewer follow-up after a late correction. Only an existing, unacknowledged correction can be acknowledged.
 */
export async function acknowledgeCorrection(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  correctionId: string;
  input: AcknowledgeCorrectionInput;
  idempotencyKey: string | null | undefined;
}) {
  authorize(args.actor, "correction.acknowledge");
  const input = AcknowledgeCorrectionInputSchema.parse(args.input);
  if (!args.idempotencyKey) {
    throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
  }

  return runCommand<CorrectionRecord>({
    tenantId: args.who.tenantId,
    operation: "correction.acknowledge",
    idempotencyKey: args.idempotencyKey,
    requestHash: computeRequestHash({ correctionId: args.correctionId, ...input }),
    actor: args.actor,
    body: async (tx) => {
      const current = (await tx.q("SELECT * FROM correction WHERE id = $1", [args.correctionId])).rows
        .find((c: any) => c.id === args.correctionId);
      if (!current) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      if (current.status === "ACKNOWLEDGED") {
        throw new AppError("CONFLICT", "This correction has already been acknowledged.");
      }

      const acknowledgedAt = new Date().toISOString();
      await tx.q(
        "UPDATE correction SET status = $1, acknowledged_by = $2, acknowledged_at = $3, reviewer_notes = $4 WHERE id = $5",
        ["ACKNOWLEDGED", args.actor.principalId, acknowledgedAt, input.reviewerNotes, args.correctionId]
      );

      const updated = { ...current, status: "ACKNOWLEDGED", acknowledged_by: args.actor.principalId, acknowledged_at: acknowledgedAt, reviewer_notes: input.reviewerNotes };
      return {
        result: toView(updated),
        audit: {
          purpose: args.who.purpose,
          command: "correction.acknowledge",
          resourceType: "correction",
          resourceId: args.correctionId,
          resourceVersion: 2,
          result: "SUCCESS" as const,
          evidenceRefs: [`correction/${args.correctionId}`]
        },
        events: [{
          aggregate: "correction",
          aggregateId: args.correctionId,
          aggregateVersion: 2,
          eventType: "correction.acknowledged",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`correction/${args.correctionId}`]
        }]
      };
    }
  });
}
