// backend/src/domains/lifecycle/policy.ts
import crypto from "node:crypto";
import { AppError } from "../../platform/errors";
import { DataCategory, JurisdictionPackContent } from "../../contracts/retention";

/**
 * Lowest retention a tenant may configure for work facts regardless of jurisdiction pack.
 * Not a legal duration: Phase 3 refuses to release cohort results over windows shorter than
 * 28 days, so purging sooner would make every Privacy Release impossible.
 */
export const MEASUREMENT_MIN_RETENTION_DAYS = 28;

export interface PackRow {
  pack_id: string;
  version: number;
  jurisdiction: string;
  sector: string;
  effective_from: string | Date;
  effective_to: string | Date | null;
  status: "APPROVED" | "RETIRED";
  content: JurisdictionPackContent;
  content_hash: string;
  approved_by: string;
}

export interface HoldRow {
  id: string;
  data_category: DataCategory;
  scope_connection_id: string | null;
  released_at: string | Date | null;
}

export interface FactRow {
  id: string;
  connection_id: string;
  end_at: string | Date;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const ms = (d: string | Date) => new Date(d).getTime();

/**
 * Effective-dated resolution over [effective_from, effective_to). Only APPROVED versions count.
 * Returns null when no version covers the instant: callers must fail closed.
 */
export function resolveEffectivePack(versions: PackRow[], at: Date): PackRow | null {
  const t = at.getTime();
  const covering = versions
    .filter(v => v.status === "APPROVED")
    .filter(v => ms(v.effective_from) <= t && (v.effective_to === null || t < ms(v.effective_to)))
    .sort((a, b) => b.version - a.version);
  return covering[0] ?? null;
}

/**
 * Publishing is append-only: versions are sequential, start strictly after their predecessor,
 * and never overlap. An open-ended predecessor is closed at the new version's start.
 */
export function planPackPublish(
  existing: PackRow[],
  candidate: { version: number; effectiveFrom: Date }
): { closePrior: { version: number; effectiveTo: Date } | null } {
  const latest = [...existing].sort((a, b) => b.version - a.version)[0];
  const expectedVersion = latest ? latest.version + 1 : 1;

  if (candidate.version !== expectedVersion) {
    throw new AppError("CONFLICT", `Pack version ${candidate.version} rejected; next version must be ${expectedVersion}. Published versions are immutable.`);
  }
  if (!latest) return { closePrior: null };

  if (candidate.effectiveFrom.getTime() <= ms(latest.effective_from)) {
    throw new AppError("CONFLICT", "A new pack version must take effect after the version it supersedes.");
  }
  if (latest.effective_to !== null) {
    if (candidate.effectiveFrom.getTime() < ms(latest.effective_to)) {
      throw new AppError("CONFLICT", "Pack version effective periods must not overlap.");
    }
    return { closePrior: null };
  }
  return { closePrior: { version: latest.version, effectiveTo: candidate.effectiveFrom } };
}

/**
 * Bounds a tenant-chosen duration by the pack in effect and the measurement minimum.
 * Returns null when allowed, or the reason it is not.
 */
export function retentionBoundsViolation(
  days: number,
  category: DataCategory,
  pack: PackRow
): string | null {
  if (days < MEASUREMENT_MIN_RETENTION_DAYS) {
    return `Retention below ${MEASUREMENT_MIN_RETENTION_DAYS} days would prevent any Privacy Release (minimum observation window).`;
  }
  const bounds = pack.content.retention?.[category];
  if (bounds?.floor && days < bounds.floor.days) {
    return `Retention of ${days} days is below the ${pack.pack_id} v${pack.version} floor of ${bounds.floor.days} days (${bounds.floor.citation}).`;
  }
  if (bounds?.ceiling && days > bounds.ceiling.days) {
    return `Retention of ${days} days exceeds the ${pack.pack_id} v${pack.version} ceiling of ${bounds.ceiling.days} days (${bounds.ceiling.citation}).`;
  }
  return null;
}

export function holdCovers(hold: HoldRow, category: DataCategory, connectionId: string): boolean {
  return hold.released_at === null
    && hold.data_category === category
    && (hold.scope_connection_id === null || hold.scope_connection_id === connectionId);
}

/**
 * Splits facts past the cutoff into those that may be purged and those an active legal hold retains.
 * Invariant: eligible === purge.length + held.length.
 */
export function partitionForPurge<T extends FactRow>(
  facts: T[],
  holds: HoldRow[],
  cutoff: Date
): { eligible: number; purge: T[]; held: T[] } {
  const expired = facts.filter(f => ms(f.end_at) < cutoff.getTime());
  const purge: T[] = [];
  const held: T[] = [];
  for (const f of expired) {
    (holds.some(h => holdCovers(h, "WORK_FACT", f.connection_id)) ? held : purge).push(f);
  }
  return { eligible: expired.length, purge, held };
}
