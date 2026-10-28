// backend/src/domains/ingest/freshness.ts

export type ConnectionHealth = "FRESH" | "DELAYED" | "STALE" | "NEVER_SYNCED";

export interface FreshnessTarget {
  lastSuccessAt: string | Date | null;
  expectedCadenceSeconds: number;
}

/**
 * deriveConnectionHealth: Derives connection freshness strictly from elapsed time, never from counts.
 * Rule: "No data" is not "no work". An outage produces STALE state, never zero work or reduced risk.
 */
export function deriveConnectionHealth(conn: FreshnessTarget, now: Date = new Date()): ConnectionHealth {
  if (!conn.lastSuccessAt) {
    return "NEVER_SYNCED";
  }

  const lastMs = typeof conn.lastSuccessAt === "string" 
    ? new Date(conn.lastSuccessAt).getTime() 
    : conn.lastSuccessAt.getTime();
  
  const lagSec = Math.max(0, (now.getTime() - lastMs) / 1000);
  const cadence = conn.expectedCadenceSeconds || 3600;

  if (lagSec > cadence * 3) {
    return "STALE"; // Downstream measures will say STALE, not 'improved'
  }
  if (lagSec > cadence * 1.5) {
    return "DELAYED";
  }
  return "FRESH";
}

