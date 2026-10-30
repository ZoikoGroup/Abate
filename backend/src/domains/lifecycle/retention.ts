// backend/src/domains/lifecycle/retention.ts
import crypto from "node:crypto";
import { withTenant, Tx } from "../../platform/db/with-tenant";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { AppError } from "../../platform/errors";
import { loadConfig } from "../../platform/config";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { recordKeyDigest } from "../work/record-key";
import {
  DataCategory,
  SetRetentionClassInput,
  PlaceLegalHoldInput,
  ReleaseLegalHoldInput,
  RetentionRunReceipt,
  JurisdictionCoverage
} from "../../contracts/retention";
import {
  retentionBoundsViolation,
  partitionForPurge,
  canonicalJson,
  sha256Hex,
  FactRow,
  HoldRow
} from "./policy";
import { resolveTenantCoverage } from "./jurisdiction";

const cfg = loadConfig();
const DAY_MS = 24 * 3600 * 1000;

// Retention and legal holds change what evidence survives; only accountable owners may set them.
const RETENTION_ADMIN_ROLES = ["RISK_OWNER", "EMPLOYER_ADMIN"];

export function requireRetentionAdmin(actor: Actor, command: string): void {
  authorize(actor, command);
  if (!actor.memberships.some(m => RETENTION_ADMIN_ROLES.includes(m.domain_role))) {
    throw new AppError("FORBIDDEN", "Only a Risk Owner or Employer Admin may change retention or legal holds.");
  }
}

function requireIdempotencyKey(key: string | null | undefined): string {
  if (!key) {
    throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
  }
  return key;
}

interface RunPlan {
  status: RetentionRunReceipt["status"];
  blockedReason: string | null;
  activeClass: any | null;
  cutoff: Date | null;
  eligible: number;
  purge: (FactRow & Record<string, any>)[];
  held: FactRow[];
}

/**
 * Decides what a run would do at `now`, without writing. Fails closed:
 * no ACTIVE class => NO_POLICY; no covering pack or duration now out of bounds => BLOCKED.
 */
async function planRun(tx: Tx, category: DataCategory, now: Date): Promise<RunPlan> {
  const none = { cutoff: null, eligible: 0, purge: [], held: [] };
  const classes = (await tx.q(`SELECT * FROM retention_class WHERE data_category = $1`, [category])).rows;
  const activeClass = classes.find((c: any) => c.status === "ACTIVE" && c.data_category === category) ?? null;
  if (!activeClass) {
    return { status: "NO_POLICY", blockedReason: null, activeClass: null, ...none };
  }

  const { pack } = await resolveTenantCoverage(tx, now);
  const blockedReason = pack
    ? retentionBoundsViolation(activeClass.retention_days, category, pack)
    : "No approved jurisdiction pack is in effect for this tenant.";
  if (blockedReason) {
    return { status: "BLOCKED", blockedReason, activeClass, ...none };
  }

  const cutoff = new Date(now.getTime() - activeClass.retention_days * DAY_MS);
  const facts = (await tx.q(`SELECT * FROM work_fact_revision WHERE end_at < $1`, [cutoff.toISOString()])).rows;
  const holds: HoldRow[] = (await tx.q(`SELECT * FROM legal_hold WHERE released_at IS NULL`)).rows;
  const { eligible, purge, held } = partitionForPurge(facts, holds, cutoff);

  return { status: "COMPLETED", blockedReason: null, activeClass, cutoff, eligible, purge, held };
}

export async function getRetentionState(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}): Promise<{
  coverage: JurisdictionCoverage;
  classes: any[];
  holds: any[];
  runs: any[];
  tombstones: { total: number; verified: number; recent: any[] };
}> {
  authorize(args.actor, "retention.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const { coverage } = await resolveTenantCoverage(tx, new Date());
    const classes = (await tx.q(`SELECT * FROM retention_class`)).rows
      .sort((a: any, b: any) => b.version - a.version);
    const holds = (await tx.q(`SELECT * FROM legal_hold`)).rows
      .sort((a: any, b: any) => +new Date(b.placed_at) - +new Date(a.placed_at));
    const runs = (await tx.q(`SELECT * FROM retention_run`)).rows
      .sort((a: any, b: any) => +new Date(b.completed_at) - +new Date(a.completed_at));
    const tombstones = (await tx.q(`SELECT * FROM deletion_tombstone`)).rows
      .sort((a: any, b: any) => +new Date(b.deleted_at) - +new Date(a.deleted_at));

    return {
      coverage,
      classes,
      holds,
      runs,
      tombstones: {
        total: tombstones.length,
        verified: tombstones.filter((t: any) => t.verified_at).length,
        // Digests and internal refs only: tombstones hold no pseudonym and no source record id
        recent: tombstones.slice(0, 20).map((t: any) => ({
          id: t.id,
          runId: t.run_id,
          dataCategory: t.data_category,
          recordDigest: t.record_digest,
          deletedAt: t.deleted_at,
          verifiedAt: t.verified_at
        }))
      }
    };
  });
}

export async function previewRetention(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  dataCategory: DataCategory;
  now?: Date;
}): Promise<{ status: RetentionRunReceipt["status"]; blockedReason: string | null; cutoff: string | null; eligible: number; held: number; purgeable: number }> {
  authorize(args.actor, "retention.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const plan = await planRun(tx, args.dataCategory, args.now ?? new Date());
    return {
      status: plan.status,
      blockedReason: plan.blockedReason,
      cutoff: plan.cutoff?.toISOString() ?? null,
      eligible: plan.eligible,
      held: plan.held.length,
      purgeable: plan.purge.length
    };
  });
}

/**
 * New versions supersede the ACTIVE one; nothing is overwritten. Refused unless a jurisdiction
 * pack is in effect and the duration sits inside its floor/ceiling.
 */
export async function setRetentionClass(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  input: SetRetentionClassInput;
  idempotencyKey: string | null | undefined;
}) {
  requireRetentionAdmin(args.actor, "retention.class.set");
  const input = SetRetentionClassInput.parse(args.input);

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "retention.class.set",
    idempotencyKey: requireIdempotencyKey(args.idempotencyKey),
    requestHash: computeRequestHash(input),
    actor: args.actor,
    body: async (tx) => {
      const { pack } = await resolveTenantCoverage(tx, new Date());
      if (!pack) {
        throw new AppError("VALIDATION", "No approved jurisdiction pack is in effect for this tenant; retention cannot be configured.");
      }
      const violation = retentionBoundsViolation(input.retentionDays, input.dataCategory, pack);
      if (violation) {
        throw new AppError("VALIDATION", violation);
      }

      const existing = (await tx.q(`SELECT * FROM retention_class WHERE data_category = $1`, [input.dataCategory])).rows
        .filter((c: any) => c.data_category === input.dataCategory);
      const prior = existing.find((c: any) => c.status === "ACTIVE");
      const version = existing.reduce((max: number, c: any) => Math.max(max, c.version), 0) + 1;

      if (prior) {
        await tx.q(`UPDATE retention_class SET status = 'SUPERSEDED' WHERE id = $1`, [prior.id]);
      }

      const id = crypto.randomUUID();
      await tx.q(
        `INSERT INTO retention_class (id, tenant_id, data_category, retention_days, basis, version, status, pack_id, pack_version, set_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9)`,
        [id, tx.tenantId, input.dataCategory, input.retentionDays, input.basis, version, pack.pack_id, pack.version, args.actor.principalId]
      );

      const result = {
        id,
        dataCategory: input.dataCategory,
        retentionDays: input.retentionDays,
        basis: input.basis,
        version,
        status: "ACTIVE",
        packId: pack.pack_id,
        packVersion: pack.version,
        supersededId: prior?.id ?? null
      };

      return {
        result,
        audit: {
          purpose: args.who.purpose,
          command: "retention.class.set",
          resourceType: "retention_class",
          resourceId: id,
          resourceVersion: version,
          result: "SUCCESS" as const,
          evidenceRefs: [`retention_class/${id}`, `jurisdiction_pack/${pack.pack_id}@${pack.version}`]
        },
        events: [{
          aggregate: "retention_class",
          aggregateId: id,
          aggregateVersion: version,
          eventType: "retention.class.changed",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`retention_class/${id}`]
        }]
      };
    }
  });
}

export async function placeLegalHold(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  input: PlaceLegalHoldInput;
  idempotencyKey: string | null | undefined;
}) {
  requireRetentionAdmin(args.actor, "legal_hold.place");
  const input = PlaceLegalHoldInput.parse(args.input);

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "legal_hold.place",
    idempotencyKey: requireIdempotencyKey(args.idempotencyKey),
    requestHash: computeRequestHash(input),
    actor: args.actor,
    body: async (tx) => {
      if (input.scopeConnectionId) {
        const conn = await tx.q(`SELECT id FROM connection WHERE id = $1`, [input.scopeConnectionId]);
        if (!conn.rows.some((c: any) => c.id === input.scopeConnectionId)) {
          throw new AppError("NOT_FOUND", "Not found.");
        }
      }

      const id = crypto.randomUUID();
      const placedAt = new Date().toISOString();
      await tx.q(
        `INSERT INTO legal_hold (id, tenant_id, data_category, scope_connection_id, matter_ref, reason, placed_by, placed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, tx.tenantId, input.dataCategory, input.scopeConnectionId ?? null, input.matterRef, input.reason, args.actor.principalId, placedAt]
      );

      return {
        result: {
          id,
          dataCategory: input.dataCategory,
          scopeConnectionId: input.scopeConnectionId ?? null,
          matterRef: input.matterRef,
          placedBy: args.actor.principalId,
          placedAt,
          active: true
        },
        audit: {
          purpose: args.who.purpose,
          command: "legal_hold.place",
          resourceType: "legal_hold",
          resourceId: id,
          result: "SUCCESS" as const,
          evidenceRefs: [`legal_hold/${id}`]
        },
        events: [{
          aggregate: "legal_hold",
          aggregateId: id,
          aggregateVersion: 1,
          eventType: "legal_hold.placed",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`legal_hold/${id}`]
        }]
      };
    }
  });
}

export async function releaseLegalHold(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  holdId: string;
  input: ReleaseLegalHoldInput;
  idempotencyKey: string | null | undefined;
}) {
  requireRetentionAdmin(args.actor, "legal_hold.release");
  const input = ReleaseLegalHoldInput.parse(args.input);

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "legal_hold.release",
    idempotencyKey: requireIdempotencyKey(args.idempotencyKey),
    requestHash: computeRequestHash({ holdId: args.holdId, ...input }),
    actor: args.actor,
    body: async (tx) => {
      const hold = (await tx.q(`SELECT * FROM legal_hold WHERE id = $1`, [args.holdId])).rows
        .find((h: any) => h.id === args.holdId);
      if (!hold) {
        throw new AppError("NOT_FOUND", "Not found.");
      }
      if (hold.released_at) {
        throw new AppError("CONFLICT", "This legal hold has already been released.");
      }

      const releasedAt = new Date().toISOString();
      await tx.q(
        `UPDATE legal_hold SET released_by = $1, released_at = $2, release_reason = $3 WHERE id = $4`,
        [args.actor.principalId, releasedAt, input.releaseReason, args.holdId]
      );

      return {
        result: { id: args.holdId, releasedBy: args.actor.principalId, releasedAt, active: false },
        audit: {
          purpose: args.who.purpose,
          command: "legal_hold.release",
          resourceType: "legal_hold",
          resourceId: args.holdId,
          resourceVersion: 2,
          result: "SUCCESS" as const,
          evidenceRefs: [`legal_hold/${args.holdId}`]
        },
        events: [{
          aggregate: "legal_hold",
          aggregateId: args.holdId,
          aggregateVersion: 2,
          eventType: "legal_hold.released",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`legal_hold/${args.holdId}`]
        }]
      };
    }
  });
}

/**
 * Tombstone, delete, then re-read to confirm each fact is gone. Shared by retention runs and
 * rights-request erasure. The storage guard refuses any delete without a prior tombstone or under
 * an active legal hold; any verification miss throws and rolls the caller's transaction back.
 * Returns the number of verified deletions.
 */
export async function purgeWithTombstones(
  tx: Tx,
  facts: Array<FactRow & Record<string, any>>,
  opts: { runId: string; category: DataCategory; tenantSecret: string }
): Promise<number> {
  for (const fact of facts) {
    await tx.q(
      `INSERT INTO deletion_tombstone (id, tenant_id, run_id, data_category, record_ref, record_digest, record_key_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        crypto.randomUUID(),
        tx.tenantId,
        opts.runId,
        opts.category,
        fact.id,
        sha256Hex(canonicalJson(fact)),
        recordKeyDigest(opts.tenantSecret, {
          connectionId: fact.connection_id,
          sourceRecordId: fact.source_record_id,
          revision: fact.revision
        })
      ]
    );
    await tx.q(`DELETE FROM work_fact_revision WHERE id = $1`, [fact.id]);
  }

  if (facts.length === 0) return 0;

  const purgedIds = facts.map(f => f.id);
  const remaining = new Set(
    (await tx.q(`SELECT id FROM work_fact_revision WHERE id = ANY($1)`, [purgedIds])).rows.map((r: any) => r.id)
  );
  const verifiedAt = new Date().toISOString();
  for (const id of purgedIds) {
    if (remaining.has(id)) {
      throw new AppError("UNAVAILABLE", "Deletion could not be verified; the operation was rolled back.");
    }
    await tx.q(`UPDATE deletion_tombstone SET verified_at = $1 WHERE record_ref = $2`, [verifiedAt, id]);
  }
  return purgedIds.length;
}

/**
 * Purge run: for each expired, unheld fact write a tombstone, delete the row, then re-read to
 * verify absence. Any verification miss rolls the whole run back. The receipt holds counts only.
 */
export async function runRetention(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  dataCategory: DataCategory;
  idempotencyKey: string | null | undefined;
  now?: Date;
}) {
  requireRetentionAdmin(args.actor, "retention.run");
  const now = args.now ?? new Date();
  const tenantSecret = `${cfg.authSecret}:${args.who.tenantId}`;

  return runCommand<RetentionRunReceipt>({
    tenantId: args.who.tenantId,
    operation: "retention.run",
    idempotencyKey: requireIdempotencyKey(args.idempotencyKey),
    requestHash: computeRequestHash({ dataCategory: args.dataCategory }),
    actor: args.actor,
    body: async (tx) => {
      const runId = crypto.randomUUID();
      const plan = await planRun(tx, args.dataCategory, now);

      const verified = await purgeWithTombstones(tx, plan.purge, { runId, category: args.dataCategory, tenantSecret });

      const receipt: RetentionRunReceipt = {
        runId,
        dataCategory: args.dataCategory,
        status: plan.status,
        ...(plan.blockedReason ? { blockedReason: plan.blockedReason } : {}),
        retentionClassId: plan.activeClass?.id ?? null,
        retentionClassVersion: plan.activeClass?.version ?? null,
        cutoff: plan.cutoff?.toISOString() ?? null,
        eligible: plan.eligible,
        held: plan.held.length,
        purged: plan.purge.length,
        verified,
        completedAt: new Date().toISOString()
      };

      await tx.q(
        `INSERT INTO retention_run (id, tenant_id, data_category, status, blocked_reason, retention_class_id, retention_class_version, cutoff, eligible, held, purged, verified, run_by, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          runId, tx.tenantId, receipt.dataCategory, receipt.status, plan.blockedReason,
          receipt.retentionClassId, receipt.retentionClassVersion, receipt.cutoff,
          receipt.eligible, receipt.held, receipt.purged, receipt.verified,
          args.actor.principalId, receipt.completedAt
        ]
      );

      return {
        result: receipt,
        audit: {
          purpose: args.who.purpose,
          command: "retention.run",
          resourceType: "retention_run",
          resourceId: runId,
          result: "SUCCESS" as const,
          evidenceRefs: [`retention_run/${runId}`]
        },
        events: [{
          aggregate: "retention_run",
          aggregateId: runId,
          aggregateVersion: 1,
          eventType: "retention.run.recorded",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`retention_run/${runId}`]
        }]
      };
    }
  });
}
