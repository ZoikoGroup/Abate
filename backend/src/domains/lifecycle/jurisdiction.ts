// backend/src/domains/lifecycle/jurisdiction.ts
import { withTenant, Tx, QueryFn } from "../../platform/db/with-tenant";
import { Actor } from "../../platform/command";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import {
  JurisdictionCoverage,
  JurisdictionPackView,
  PublishPackInput
} from "../../contracts/retention";
import { PackRow, resolveEffectivePack, planPackPublish, canonicalJson, sha256Hex } from "./policy";

const iso = (d: string | Date | null) => (d === null ? null : new Date(d).toISOString());

export function packContentHash(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

export function toPackView(row: PackRow): JurisdictionPackView {
  return {
    packId: row.pack_id,
    version: row.version,
    jurisdiction: row.jurisdiction,
    sector: row.sector,
    effectiveFrom: iso(row.effective_from) as string,
    effectiveTo: iso(row.effective_to),
    status: row.status,
    content: row.content,
    contentHash: row.content_hash,
    approvedBy: row.approved_by
  };
}

/**
 * The tenant's jurisdiction_config_ref names a pack; the version applied is chosen by date.
 */
export async function loadTenantPackVersions(tx: Tx): Promise<{ packId: string | null; versions: PackRow[] }> {
  const t = await tx.q(`SELECT jurisdiction_config_ref FROM tenant WHERE id = $1`, [tx.tenantId]);
  const packId: string | null = t.rows[0]?.jurisdiction_config_ref ?? null;
  if (!packId) return { packId: null, versions: [] };

  const v = await tx.q(`SELECT * FROM jurisdiction_pack WHERE pack_id = $1`, [packId]);
  return { packId, versions: v.rows.filter((r: PackRow) => r.pack_id === packId) };
}

export async function resolveTenantCoverage(
  tx: Tx,
  at: Date
): Promise<{ coverage: JurisdictionCoverage; pack: PackRow | null }> {
  const { packId, versions } = await loadTenantPackVersions(tx);
  const pack = resolveEffectivePack(versions, at);
  const coverage: JurisdictionCoverage = pack
    ? { status: "COVERED", pack: toPackView(pack) }
    : { status: "NOT_COVERED", packId, at: at.toISOString() };
  return { coverage, pack };
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
}): Promise<{ packId: string | null; versions: JurisdictionPackView[] }> {
  authorize(args.actor, "jurisdiction.read");
  return withTenant(args.who.tenantId, async (tx) => {
    const { packId, versions } = await loadTenantPackVersions(tx);
    return {
      packId,
      versions: versions.sort((a, b) => a.version - b.version).map(toPackView)
    };
  });
}

/**
 * Platform-side publication of a pack version (Legal & Policy Lead content).
 * Not exposed to tenants: in PostgreSQL abate_app has SELECT only on jurisdiction_pack,
 * so this must run on a migrator/platform connection.
 */
export async function publishPackVersion(db: { q: QueryFn }, raw: PublishPackInput): Promise<JurisdictionPackView> {
  const input = PublishPackInput.parse(raw);
  const effectiveFrom = new Date(input.effectiveFrom);

  const existing = (await db.q(`SELECT * FROM jurisdiction_pack WHERE pack_id = $1`, [input.packId]))
    .rows.filter((r: PackRow) => r.pack_id === input.packId);
  const { closePrior } = planPackPublish(existing, { version: input.version, effectiveFrom });

  if (closePrior) {
    await db.q(
      `UPDATE jurisdiction_pack SET effective_to = $1 WHERE pack_id = $2 AND version = $3`,
      [closePrior.effectiveTo.toISOString(), input.packId, closePrior.version]
    );
  }

  const row: PackRow = {
    pack_id: input.packId,
    version: input.version,
    jurisdiction: input.jurisdiction,
    sector: input.sector,
    effective_from: effectiveFrom.toISOString(),
    effective_to: null,
    status: "APPROVED",
    content: input.content,
    content_hash: packContentHash(input.content),
    approved_by: input.approvedBy
  };

  await db.q(
    `INSERT INTO jurisdiction_pack (pack_id, version, jurisdiction, sector, effective_from, effective_to, status, content, content_hash, approved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.pack_id, row.version, row.jurisdiction, row.sector, row.effective_from, row.effective_to, row.status, row.content, row.content_hash, row.approved_by]
  );

  return toPackView(row);
}
