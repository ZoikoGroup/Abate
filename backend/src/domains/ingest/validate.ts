// backend/src/domains/ingest/validate.ts
import { ZoikoTimeIntervalV1, ZoikoTimeInterval } from "../../contracts/sources/zoikotime.v1";

export interface PartitionResult {
  ok: ZoikoTimeInterval[];
  rejected: number;
}

/**
 * partition: Validates raw batch items against the strict ZoikoTime v1 contract.
 * Rejects invalid items, ambiguous times, and unknown/prohibited fields.
 * CRITICAL RULE: Never log raw payloads or error contents to prevent decoy/surveillance echoes.
 */
export function partition(items: unknown[]): PartitionResult {
  const ok: ZoikoTimeInterval[] = [];
  let rejected = 0;

  for (const raw of items) {
    const r = ZoikoTimeIntervalV1.safeParse(raw);
    if (!r.success) {
      // Prohibited or unknown fields fail here. Never log raw or r.error.
      rejected++;
      continue;
    }

    const startMs = Date.parse(r.data.startUtc);
    const endMs = Date.parse(r.data.endUtc);

    // End must strictly be after start; rejected, not silently swapped
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
      rejected++;
      continue;
    }

    ok.push(r.data);
  }

  return { ok, rejected };
}

