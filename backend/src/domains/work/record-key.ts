// backend/src/domains/work/record-key.ts
import { createHmac } from "node:crypto";

/**
 * Keyed digest of a work fact's source identity (connection, source record, revision).
 * Retention tombstones store this instead of the source record id, so a purged record can be
 * recognised and refused on re-delivery without the tombstone revealing which record it was.
 */
export function recordKeyDigest(
  tenantSecret: string | Buffer,
  key: { connectionId: string; sourceRecordId: string; revision: number }
): string {
  const secret = typeof tenantSecret === "string" ? Buffer.from(tenantSecret, "utf-8") : tenantSecret;
  return createHmac("sha256", secret)
    .update(`${key.connectionId}\u0000${key.sourceRecordId.normalize("NFC")}\u0000${key.revision}`)
    .digest("hex");
}
