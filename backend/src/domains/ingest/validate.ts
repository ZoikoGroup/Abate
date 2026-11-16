// backend/src/domains/ingest/validate.ts
import { ZodType } from "zod";
import { ZoikoTimeIntervalV1, ZoikoTimeInterval } from "../../contracts/sources/zoikotime.v1";
import { CalendarCadenceEventV1, CalendarCadenceEvent } from "../../contracts/sources/calendar-cadence.v1";

export interface PartitionResult<T = ZoikoTimeInterval> {
  ok: T[];
  rejected: number;
}

/**
 * Calculates timezone offset in minutes for an IANA timezone at a specific Date.
 */
export function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  try {
    const str = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).format(date);
    const m = str.match(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/);
    if (!m) return 0;
    const asUtc = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
    return (asUtc - date.getTime()) / 60000;
  } catch {
    return 0;
  }
}

/**
 * isDstTransitionAmbiguity:
 * Detects whether a UTC timestamp falls within a Daylight Saving Time transition window
 * (either an ambiguous repeated hour during autumn fall-back, or a non-existent gap during spring forward).
 * In an approved contract, intervals that fall into ambiguous local times must be rejected
 * unless explicit disambiguation is provided by the source.
 */
export function isDstTransitionAmbiguity(date: Date, timeZone: string): boolean {
  try {
    const offsetNow = getTimezoneOffsetMinutes(date, timeZone);
    const offsetBefore = getTimezoneOffsetMinutes(new Date(date.getTime() - 60 * 60 * 1000), timeZone);
    const offsetAfter = getTimezoneOffsetMinutes(new Date(date.getTime() + 60 * 60 * 1000), timeZone);
    return (offsetBefore !== offsetNow || offsetNow !== offsetAfter);
  } catch {
    return false;
  }
}

// Allowance for future timestamps: maximum 7 days ahead of current wall-clock
const MAX_FUTURE_ALLOWANCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * partitionWithSchema: Validates raw batch items against a strict source contract schema.
 * Rejects invalid items, ambiguous DST times, future dates beyond the limit, and unknown/prohibited fields.
 * CRITICAL RULE: Never log raw payloads or error contents to prevent decoy/surveillance echoes.
 */
export function partitionWithSchema<T extends { startUtc: string; endUtc: string; workTz: string }>(
  items: unknown[],
  schema: ZodType<T>
): PartitionResult<T> {
  const ok: T[] = [];
  let rejected = 0;
  const now = Date.now();

  for (const raw of items) {
    const r = schema.safeParse(raw);
    if (!r.success) {
      // Prohibited, unknown, or invalid kind/tz fields fail here. Never log raw or r.error.
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

    // Future date beyond allowable limit rejected
    if (startMs > now + MAX_FUTURE_ALLOWANCE_MS || endMs > now + MAX_FUTURE_ALLOWANCE_MS) {
      rejected++;
      continue;
    }

    // Ambiguous DST transition boundary rejected
    if (isDstTransitionAmbiguity(new Date(startMs), r.data.workTz) || isDstTransitionAmbiguity(new Date(endMs), r.data.workTz)) {
      rejected++;
      continue;
    }

    ok.push(r.data);
  }

  return { ok, rejected };
}

/**
 * partition: Validates raw batch items against the strict ZoikoTime v1 contract.
 */
export function partition(items: unknown[]): PartitionResult<ZoikoTimeInterval> {
  return partitionWithSchema(items, ZoikoTimeIntervalV1);
}

/**
 * partitionCalendarCadence: Validates raw batch items against the strict CalendarCadence v1 contract.
 */
export function partitionCalendarCadence(items: unknown[]): PartitionResult<CalendarCadenceEvent> {
  return partitionWithSchema(items, CalendarCadenceEventV1);
}
