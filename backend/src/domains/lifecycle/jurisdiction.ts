// backend/src/domains/lifecycle/jurisdiction.ts
import crypto from "node:crypto";
import { withTenant, Tx, QueryFn } from "../../platform/db/with-tenant";
import { Actor } from "../../platform/command";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import {
  JurisdictionCoverage,
  JurisdictionPackView,
  PublishPackInput
} from "../../contracts/retention";
import { PackRow, resolveEffectivePack, planPackPublish, canonicalJson, sha256Hex } from "./policy";
import { activeBindings } from "./resolve";

const iso = (d: string | Date | null) => (d === null ? null : new Date(d).toISOString());

export function packContentHash(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

export function toPackView(row: PackRow): JurisdictionPackView {
  return {
    packKey: row.pack_key,
    version: row.version,
    kind: row.kind,
    title: String(row.content.title ?? row.pack_key),
    effectiveFrom: iso(row.effective_from) as string,
    effectiveTo: iso(row.effective_to),
    status: row.status,
    retention: row.content.retention ?? null,
    sourceRefs: typeof row.source_refs === "string" ? JSON.parse(row.source_refs) : row.source_refs,
    accountableReviewer: row.accountable_reviewer,
    contentHash: row.content_hash
  };
}

async function packVersions(db: { q: QueryFn }, packKey: string): Promise<PackRow[]> {
  return (await db.q("SELECT * FROM policy_pack WHERE pack_key = $1", [packKey])).rows
    .filter((r: PackRow) => r.pack_key === packKey);
}

/**
 * The JURISDICTION packs bound to the tenant at `at`, each with its full version history.
 * Packs come from the single policy_pack catalog; tenants reach them only through tenant_policy_binding.
 */
export async function loadTenantJurisdictionPacks(tx: Tx, at: Date): Promise<Array<{ packKey: string; versions: PackRow[] }>> {
  const out: Array<{ packKey: string; versions: PackRow[] }> = [];
  for (const binding of await activeBindings(tx, tx.tenantId, at)) {
    const versions = await packVersions(tx, binding.pack_key);
    if (versions.some(v => v.kind === "JURISDICTION")) {
      out.push({ packKey: binding.pack_key, versions: versions.filter(v => v.kind === "JURISDICTION") });
    }
  }
  return out;
}

/**
 * Exactly one approved JURISDICTION pack must be in effect; none or several fails closed.
 */
export async function resolveTenantCoverage(
  tx: Tx,
  at: Date
): Promise<{ coverage: JurisdictionCoverage; pack: PackRow | null }> {
  const bound = await loadTenantJurisdictionPacks(tx, at);
  const effective = bound
    .map(b => resolveEffectivePack(b.versions, at))
    .filter((p): p is PackRow => p !== null);
  const notCovered = (reason: string) => ({
    coverage: { status: "NOT_COVERED" as const, reason, boundPackKeys: bound.map(b => b.packKey), at: at.toISOString() },
    pack: null
  });

  if (effective.length === 0) return notCovered("No approved jurisdiction pack is in effect for this tenant.");
  if (effective.length > 1) {
    return notCovered(`More than one jurisdiction pack is in effect (${effective.map(p => p.pack_key).join(", ")}); resolve the binding first.`);
  }
  return { coverage: { status: "COVERED", pack: toPackView(effective[0]!) }, pack: effective[0]! };
}

export async function getJurisdictionCoverage(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  at?: Date;
}): Promise<JurisdictionCoverage> {
  authorize(args.actor, "jurisdiction.read");
  return withTenant(args.who.tenantId, async (tx) => {
    return (await resolveTenantCoverage(tx, args.at ?? new Date())).coverage;
  });
}

export async function listJurisdictionPackVersions(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}): Promise<{ packKeys: string[]; versions: JurisdictionPackView[] }> {
  authorize(args.actor, "jurisdiction.read");
  return withTenant(args.who.tenantId, async (tx) => {
    const bound = await loadTenantJurisdictionPacks(tx, new Date());
    return {
      packKeys: bound.map(b => b.packKey),
      versions: bound
        .flatMap(b => b.versions)
        .sort((a, b) => a.pack_key.localeCompare(b.pack_key) || a.version - b.version)
        .map(toPackView)
    };
  });
}

/**
 * Platform-side publication of a pack version (Legal & Policy Lead content) into policy_pack.
 * Not exposed to tenants: in PostgreSQL abate_app has SELECT only on policy_pack,
 * so this must run on a migrator/platform connection.
 */
export async function publishPackVersion(db: { q: QueryFn }, raw: PublishPackInput): Promise<JurisdictionPackView> {
  const input = PublishPackInput.parse(raw);
  const effectiveFrom = new Date(input.effectiveFrom);

  const existing = await packVersions(db, input.packKey);
  const { closePrior } = planPackPublish(existing, { version: input.version, effectiveFrom });

  if (closePrior) {
    await db.q(
      `UPDATE policy_pack SET effective_to = $1 WHERE pack_key = $2 AND version = $3`,
      [closePrior.effectiveTo.toISOString(), input.packKey, closePrior.version]
    );
  }

  const row: PackRow = {
    id: crypto.randomUUID(),
    pack_key: input.packKey,
    version: input.version,
    kind: input.kind,
    effective_from: effectiveFrom.toISOString(),
    effective_to: null,
    status: "APPROVED",
    source_refs: input.sourceRefs,
    accountable_reviewer: input.accountableReviewer,
    review_date: input.reviewDate,
    content: input.content,
    content_hash: packContentHash(input.content)
  };

  await db.q(
    `INSERT INTO policy_pack (id, pack_key, version, kind, effective_from, effective_to, status, source_refs, accountable_reviewer, review_date, content, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.id, row.pack_key, row.version, row.kind, row.effective_from, row.effective_to, row.status,
      JSON.stringify(row.source_refs), row.accountable_reviewer, row.review_date, JSON.stringify(row.content), row.content_hash
    ]
  );

  return toPackView(row);
}
