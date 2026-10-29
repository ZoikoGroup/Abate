// backend/src/domains/measure/intervals.ts
// Pure interval arithmetic for deterministic measurement (Domain S04)

export type Interval = { start: number; end: number }; // epoch milliseconds, start < end

/**
 * union: Merges overlapping and touching intervals so work time is not double-counted.
 */
export function union(xs: Interval[]): Interval[] {
  if (xs.length === 0) return [];
  const s = [...xs].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];

  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) {
      last.end = Math.max(last.end, x.end); // merge overlaps/touching
    } else {
      out.push({ ...x });
    }
  }

  return out;
}

/**
 * minutes: Calculates the exact total duration in minutes of an interval list.
 */
export const minutes = (xs: Interval[]) =>
  xs.reduce((m, i) => m + (i.end - i.start) / 60000, 0);

/**
 * intersect: Computes the intersection of work intervals against a target window/schedule.
 */
export function intersect(xs: Interval[], window: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const a of xs) {
    for (const w of window) {
      const s = Math.max(a.start, w.start);
      const e = Math.min(a.end, w.end);
      if (s < e) {
        out.push({ start: s, end: e });
      }
    }
  }
  return union(out);
}

