// backend/src/platform/slo.ts
import { RequestRecord, RouteClass } from "./telemetry";

/**
 * B8 SLO targets from adr/decisions-register.md ("SLO Workload Targets").
 */
export const SLO_P95_TARGET_MS: Record<Exclude<RouteClass, "EXCLUDED">, number> = {
  READ: 500,
  WRITE: 800,
  RELEASED_ANALYTICS: 1500
};
export const AVAILABILITY_TARGET = 0.999;

export type SloStatus = "MET" | "BREACHED" | "NO_DATA";

export interface SloReport {
  generatedAt: string;
  window: { from: string | null; to: string | null; requests: number };
  latency: Array<{ routeClass: keyof typeof SLO_P95_TARGET_MS; targetP95Ms: number; p95Ms: number | null; requests: number; status: SloStatus }>;
  availability: {
    requests: number;
    serverErrors: number;
    ratio: number | null;
    target: number;
    errorBudget: { allowedFailures: number; consumed: number; remaining: number };
    status: SloStatus;
  };
  slowestRoutes: Array<{ route: string; method: string; routeClass: RouteClass; p95Ms: number; requests: number }>;
  overall: SloStatus;
  scope: string;
}

/** Nearest-rank p95. */
export function p95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function buildSloReport(records: RequestRecord[], now: Date = new Date()): SloReport {
  const counted = records.filter(r => r.routeClass !== "EXCLUDED");

  const latency = (Object.keys(SLO_P95_TARGET_MS) as Array<keyof typeof SLO_P95_TARGET_MS>).map(routeClass => {
    const samples = counted.filter(r => r.routeClass === routeClass).map(r => r.durationMs);
    const value = p95(samples);
    const target = SLO_P95_TARGET_MS[routeClass];
    return {
      routeClass,
      targetP95Ms: target,
      p95Ms: value === null ? null : round(value),
      requests: samples.length,
      status: (value === null ? "NO_DATA" : value <= target ? "MET" : "BREACHED") as SloStatus
    };
  });

  // Availability counts server faults only; 4xx are correct refusals, not outages
  const serverErrors = counted.filter(r => r.status >= 500).length;
  const ratio = counted.length ? (counted.length - serverErrors) / counted.length : null;
  const allowedFailures = Math.floor(counted.length * (1 - AVAILABILITY_TARGET));
  const availabilityStatus: SloStatus = ratio === null ? "NO_DATA" : ratio >= AVAILABILITY_TARGET ? "MET" : "BREACHED";

  const byRoute = new Map<string, RequestRecord[]>();
  for (const r of counted) {
    const key = `${r.method} ${r.route}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), r]);
  }
  const slowestRoutes = Array.from(byRoute.values())
    .map(rs => ({ route: rs[0]!.route, method: rs[0]!.method, routeClass: rs[0]!.routeClass, p95Ms: round(p95(rs.map(r => r.durationMs))!), requests: rs.length }))
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, 5);

  const statuses = [...latency.map(l => l.status), availabilityStatus];
  const overall: SloStatus = statuses.includes("BREACHED") ? "BREACHED" : statuses.every(s => s === "NO_DATA") ? "NO_DATA" : "MET";

  return {
    generatedAt: now.toISOString(),
    window: { from: counted[0]?.at ?? null, to: counted[counted.length - 1]?.at ?? null, requests: counted.length },
    latency,
    availability: {
      requests: counted.length,
      serverErrors,
      ratio,
      target: AVAILABILITY_TARGET,
      errorBudget: { allowedFailures, consumed: serverErrors, remaining: allowedFailures - serverErrors },
      status: availabilityStatus
    },
    slowestRoutes,
    overall,
    scope: "In-process window since this instance started (most recent requests). Monthly 99.9% availability must be measured by external monitoring."
  };
}
