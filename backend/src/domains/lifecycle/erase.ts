// backend/src/domains/lifecycle/erase.ts
import crypto from "node:crypto";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { AppError } from "../../platform/errors";
import { loadConfig } from "../../platform/config";
import { AuthenticatedIdentity } from "../tenant/auth";
import { RightsRequestInput, RightsRequestInputSchema } from "../../contracts/governance";
import { holdCovers, HoldRow } from "./policy";
import { purgeWithTombstones, requireRetentionAdmin } from "./retention";

const cfg = loadConfig();

export interface ErasureReceipt {
  requestId: string;
  status: "COMPLETED";
  deleted: number;
  verified: number;
  heldExceptions: number;
  completedAt: string;
}

/**
 * Subject rights request (GDPR Art 17 erasure), Playbook B5 §4 Step 9.
 * - Facts under an active legal hold are kept and reported as exceptions; held data is never claimed deleted.
 * - Every other fact for the subject goes through the same tombstone -> guarded delete -> re-read
 *   verification as retention, so the result is proven, and re-delivery by the source is refused.
 */
export async function requestErasure(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  input: RightsRequestInput;
  idempotencyKey: string | null | undefined;
}) {
  requireRetentionAdmin(args.actor, "rights_request.erase");
  const input = RightsRequestInputSchema.parse(args.input);
  if (!args.idempotencyKey) {
    throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
  }

  return runCommand<ErasureReceipt>({
    tenantId: args.who.tenantId,
    operation: "rights_request.erase",
    idempotencyKey: args.idempotencyKey,
    requestHash: computeRequestHash(input),
    actor: args.actor,
    body: async (tx) => {
      const requestId = crypto.randomUUID();
      const facts = (await tx.q("SELECT * FROM work_fact_revision")).rows
        .filter((f: any) => f.subject_pseudonym === input.subjectPseudonym);
      const holds: HoldRow[] = (await tx.q("SELECT * FROM legal_hold WHERE released_at IS NULL")).rows;

      const held = facts.filter((f: any) => holds.some(h => holdCovers(h, "WORK_FACT", f.connection_id)));
      const toDelete = facts.filter((f: any) => !held.includes(f));

      const verified = await purgeWithTombstones(tx, toDelete, {
        runId: requestId,
        category: "WORK_FACT",
        tenantSecret: `${cfg.authSecret}:${tx.tenantId}`
      });

      const completedAt = new Date().toISOString();
      await tx.q(
        `INSERT INTO rights_request (
          id, tenant_id, subject_pseudonym, status, deleted_count, held_exceptions, requested_at, completed_at
        ) VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7)`,
        [requestId, tx.tenantId, input.subjectPseudonym, verified, held.length, completedAt, completedAt]
      );

      return {
        result: { requestId, status: "COMPLETED", deleted: toDelete.length, verified, heldExceptions: held.length, completedAt },
        audit: {
          purpose: args.who.purpose,
          command: "rights_request.erase",
          resourceType: "rights_request",
          resourceId: requestId,
          result: "SUCCESS" as const,
          evidenceRefs: [`rights_request/${requestId}`]
        },
        events: [{
          aggregate: "rights_request",
          aggregateId: requestId,
          aggregateVersion: 1,
          eventType: "rights_request.completed",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`rights_request/${requestId}`]
        }]
      };
    }
  });
}
