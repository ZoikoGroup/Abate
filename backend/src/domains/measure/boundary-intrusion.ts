// backend/src/domains/measure/boundary-intrusion.ts
import { Interval, union, minutes, intersect } from "./intervals";

export type MetricQuality = "VALID" | "PARTIAL" | "STALE" | "INSUFFICIENT_DATA" | "NOT_APPLICABLE";

export interface BoundaryIntrusionResult {
  quality: MetricQuality;
  value: number | null;
  totalWorkMinutes: number;
  outsideScheduleMinutes: number;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

/**
 * boundaryIntrusionShare:
 * Measures the share (%) of total work performed outside the designated schedule.
 * Crucial rule: Overlapping records are unified, never summed, preventing artificial double-counting.
 * If total work is 0 minutes, quality is NOT_APPLICABLE, NEVER 0%.
 */
export function boundaryIntrusionShare(
  work: Interval[],
  schedule: Interval[]
): BoundaryIntrusionResult {
  const w = union(work);
  const total = minutes(w);

  if (total === 0) {
    return {
      quality: "NOT_APPLICABLE",
      value: null,
      totalWorkMinutes: 0,
      outsideScheduleMinutes: 0
    };
  }

  const inside = minutes(intersect(w, schedule));
  const outside = Math.max(0, total - inside);
  const pct = round1((outside / total) * 100);

  return {
    quality: "VALID",
    value: pct,
    totalWorkMinutes: total,
    outsideScheduleMinutes: outside
  };
}

