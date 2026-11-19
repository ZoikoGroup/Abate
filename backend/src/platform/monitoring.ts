// backend/src/platform/monitoring.ts
// Prometheus metrics exposition and SLO/dependency alert evaluation (B8-safe: zero tenant IDs or PII).
import { AppConfig, isHardenedEnv } from "./config";

export interface PrivacyReleaseCounters {
  releasedTotal: number;
  suppressedTotal: number;
  engineErrorsTotal: number;
}

export interface OperationalSignals {
  staleConnectors: number;
  packResolutionFailuresTotal: number;
  aiBudgetUtilizationRatio: number;
  rateLimitedTotal: number;
}

const privacyCounters: PrivacyReleaseCounters = {
  releasedTotal: 0,
  suppressedTotal: 0,
  engineErrorsTotal: 0
};

const operationalSignals: OperationalSignals = {
  staleConnectors: 0,
  packResolutionFailuresTotal: 0,
  aiBudgetUtilizationRatio: 0,
  rateLimitedTotal: 0
};

export function recordRateLimitHit(): void {
  operationalSignals.rateLimitedTotal++;
}

export function recordPackResolutionFailure(): void {
  operationalSignals.packResolutionFailuresTotal++;
}

export function setStaleConnectorCount(count: number): void {
  operationalSignals.staleConnectors = Math.max(0, Math.floor(count));
}

export function setAiBudgetUtilizationRatio(ratio: number): void {
  operationalSignals.aiBudgetUtilizationRatio = Math.max(0, Math.min(10, Number.isFinite(ratio) ? ratio : 0));
}

export function getOperationalSignals(): OperationalSignals {
  return { ...operationalSignals };
}

export function resetOperationalSignals(): void {
  operationalSignals.staleConnectors = 0;
  operationalSignals.packResolutionFailuresTotal = 0;
  operationalSignals.aiBudgetUtilizationRatio = 0;
  operationalSignals.rateLimitedTotal = 0;
}

export function recordPrivacyOutcome(outcome: "RELEASED" | "SUPPRESSED" | "ERROR"): void {
  if (outcome === "RELEASED") {
    privacyCounters.releasedTotal++;
  } else if (outcome === "SUPPRESSED") {
    privacyCounters.suppressedTotal++;
  } else {
    privacyCounters.engineErrorsTotal++;
  }
}

export function getPrivacyCounters(): PrivacyReleaseCounters {
  return { ...privacyCounters };
}

export function resetPrivacyCounters(): void {
  privacyCounters.releasedTotal = 0;
  privacyCounters.suppressedTotal = 0;
  privacyCounters.engineErrorsTotal = 0;
}

export interface SloReportLike {
  windowMinutes?: number;
  generatedAt?: string;
  latency: Array<{
    routeClass: string;
    requests: number;
    p95Ms: number | null;
    targetP95Ms: number;
    status: "MET" | "BREACH" | "NO_DATA" | string;
  }>;
  availability: {
    requests: number;
    serverErrors: number;
    ratio: number | null;
    target: number;
    status: "MET" | "BREACH" | "NO_DATA" | string;
  };
}

export interface WorkerMetricsLike {
  state: string;
  queueDepth: number;
  queueLagMs: number;
  totalProcessed: number;
  totalFailures: number;
  totalDeadLetters: number;
}

export interface DependencyHealthLike {
  databaseOk: boolean;
  databaseRequired: boolean;
  objectStoreOk: boolean;
  objectStoreMode: string;
}

export interface OperationalAlert {
  id: string;
  severity: "critical" | "warning";
  state: "OK" | "FIRING";
  summary: string;
  value: number;
  threshold: number;
  runbookHint: string;
}

export interface AlertEvaluationReport {
  evaluatedAt: string;
  overallStatus: "OK" | "FIRING";
  summary: {
    firingCount: number;
    criticalCount: number;
    warningCount: number;
  };
  alerts: OperationalAlert[];
}

export function evaluateOperationalAlerts(params: {
  cfg: AppConfig;
  sloReport: SloReportLike;
  workerMetrics: WorkerMetricsLike;
  deps: DependencyHealthLike;
  now?: Date;
}): AlertEvaluationReport {
  const { cfg, sloReport, workerMetrics, deps } = params;
  const evaluatedAt = (params.now ?? new Date()).toISOString();
  const counters = getPrivacyCounters();
  const hardened = isHardenedEnv(cfg.appEnv);

  const alerts: OperationalAlert[] = [];

  const hasAvailSamples = sloReport.availability.requests > 0;
  const availRatio = sloReport.availability.ratio ?? 1;
  alerts.push({
    id: "AbateAvailabilitySloBreach",
    severity: "critical",
    state: hasAvailSamples && sloReport.availability.status === "BREACH" ? "FIRING" : "OK",
    summary: `API 5xx availability ratio (${(availRatio * 100).toFixed(3)}%) vs target ${(sloReport.availability.target * 100).toFixed(2)}%`,
    value: availRatio,
    threshold: sloReport.availability.target,
    runbookHint: "Inspect GET /api/v2/ops/errors and structured error fingerprints."
  });

  const breachedRoutes = sloReport.latency.filter(l => l.requests > 0 && l.status === "BREACH");
  alerts.push({
    id: "AbateRouteLatencySloBreach",
    severity: breachedRoutes.some(r => r.routeClass === "RELEASED_ANALYTICS") ? "critical" : "warning",
    state: breachedRoutes.length > 0 ? "FIRING" : "OK",
    summary: breachedRoutes.length > 0
      ? `Latency p95 breach on: ${breachedRoutes.map(r => `${r.routeClass}=${r.p95Ms}ms>${r.targetP95Ms}ms`).join(", ")}`
      : "All exercised route classes are within SLO p95 latency targets.",
    value: breachedRoutes.length,
    threshold: 0,
    runbookHint: "Check slow queries, Postgres pool saturation, and GET /api/v2/ops/slo."
  });

  alerts.push({
    id: "AbatePrivacyEngineErrorsDetected",
    severity: "critical",
    state: counters.engineErrorsTotal > 0 ? "FIRING" : "OK",
    summary: "Privacy release compiler execution errors (distinct from normal k-anonymity suppressions).",
    value: counters.engineErrorsTotal,
    threshold: 0,
    runbookHint: "Check database connectivity and compile-release errors via GET /api/v2/ops/errors."
  });

  alerts.push({
    id: "AbateWorkerDeadLettersPresent",
    severity: "critical",
    state: workerMetrics.totalDeadLetters > 0 ? "FIRING" : "OK",
    summary: "Dead-letter outbox events detected.",
    value: workerMetrics.totalDeadLetters,
    threshold: 0,
    runbookHint: "Inspect GET /api/v2/ops/jobs and dead_letter_event rows before replaying."
  });

  alerts.push({
    id: "AbateWorkerQueueLagHigh",
    severity: "warning",
    state: workerMetrics.queueLagMs > 60_000 ? "FIRING" : "OK",
    summary: "Outbox worker queue lag above 60000ms.",
    value: workerMetrics.queueLagMs,
    threshold: 60_000,
    runbookHint: "Verify worker daemon liveness and DB outbox backlog."
  });

  const dbRequired = deps.databaseRequired || hardened;
  alerts.push({
    id: "AbateDatabaseUnavailable",
    severity: "critical",
    state: dbRequired && !deps.databaseOk ? "FIRING" : "OK",
    summary: dbRequired
      ? (deps.databaseOk ? "PostgreSQL connectivity healthy." : "Required PostgreSQL database check failed.")
      : "PostgreSQL not required in current local/test mode.",
    value: deps.databaseOk ? 1 : 0,
    threshold: dbRequired ? 1 : 0,
    runbookHint: "Check DATABASE_URL_APP connectivity and PostgreSQL server health."
  });

  const s3Required = deps.objectStoreMode === "s3" || hardened;
  alerts.push({
    id: "AbateObjectStoreUnavailable",
    severity: "critical",
    state: s3Required && !deps.objectStoreOk ? "FIRING" : "OK",
    summary: s3Required
      ? (deps.objectStoreOk ? "Durable S3 object store healthy." : "Durable S3 object store check failed.")
      : "Memory object store active in local/test mode.",
    value: deps.objectStoreOk ? 1 : 0,
    threshold: s3Required ? 1 : 0,
    runbookHint: "Verify OBJECT_STORE_ENDPOINT, bucket permissions, and credentials."
  });

  const signals = getOperationalSignals();
  alerts.push({
    id: "AbateConnectorStaleDetected",
    severity: "warning",
    state: signals.staleConnectors > 0 ? "FIRING" : "OK",
    summary: "One or more source connectors exceeded 3x expected cadence (STALE).",
    value: signals.staleConnectors,
    threshold: 0,
    runbookHint: "Check connector freshness in GET /api/v2/connections; do not treat outage as zero work."
  });

  alerts.push({
    id: "AbatePackResolutionFailure",
    severity: "critical",
    state: signals.packResolutionFailuresTotal > 0 ? "FIRING" : "OK",
    summary: "Jurisdiction or policy pack resolution failed closed (NOT_COVERED or paused pack).",
    value: signals.packResolutionFailuresTotal,
    threshold: 0,
    runbookHint: "Verify active policy_pack dates, tenant_policy_binding, and pack:* kill switches."
  });

  alerts.push({
    id: "AbateAiBudgetHighUtilization",
    severity: "warning",
    state: signals.aiBudgetUtilizationRatio >= 0.8 ? "FIRING" : "OK",
    summary: "Bounded AI monthly spend reached >= 80% of configured tenant budget.",
    value: signals.aiBudgetUtilizationRatio,
    threshold: 0.8,
    runbookHint: "Review GET /api/v2/ai/quota; manual risk-control workflows remain unaffected."
  });

  alerts.push({
    id: "AbateTenantRateLimitBurst",
    severity: "warning",
    state: signals.rateLimitedTotal >= 25 ? "FIRING" : "OK",
    summary: "Sustained HTTP 429 rate-limit refusals detected (noisy-tenant protection active).",
    value: signals.rateLimitedTotal,
    threshold: 25,
    runbookHint: "Inspect noisy-tenant traffic patterns; healthy tenants remain isolated."
  });

  const firing = alerts.filter(a => a.state === "FIRING");
  return {
    evaluatedAt,
    overallStatus: firing.length > 0 ? "FIRING" : "OK",
    summary: {
      firingCount: firing.length,
      criticalCount: firing.filter(a => a.severity === "critical").length,
      warningCount: firing.filter(a => a.severity === "warning").length
    },
    alerts
  };
}

export function renderPrometheusMetrics(params: {
  sloReport: SloReportLike;
  workerMetrics: WorkerMetricsLike;
  deps: DependencyHealthLike;
}): string {
  const { sloReport, workerMetrics, deps } = params;
  const counters = getPrivacyCounters();
  const lines: string[] = [
    "# HELP abate_http_requests_total Total HTTP requests recorded by SLO route class",
    "# TYPE abate_http_requests_total counter"
  ];

  for (const row of sloReport.latency) {
    lines.push(`abate_http_requests_total{route_class="${row.routeClass}"} ${row.requests}`);
  }

  lines.push(
    "# HELP abate_http_request_duration_ms_p95 Rolling p95 latency in milliseconds by route class",
    "# TYPE abate_http_request_duration_ms_p95 gauge"
  );
  for (const row of sloReport.latency) {
    lines.push(`abate_http_request_duration_ms_p95{route_class="${row.routeClass}"} ${row.p95Ms ?? 0}`);
  }

  lines.push(
    "# HELP abate_http_server_errors_total Total HTTP 5xx server responses",
    "# TYPE abate_http_server_errors_total counter",
    `abate_http_server_errors_total ${sloReport.availability.serverErrors}`,
    "# HELP abate_http_availability_ratio Rolling 1 - (5xx / total) availability ratio",
    "# TYPE abate_http_availability_ratio gauge",
    `abate_http_availability_ratio ${sloReport.availability.ratio ?? 1}`,
    "# HELP abate_privacy_released_total Approved k-anonymous privacy releases served",
    "# TYPE abate_privacy_released_total counter",
    `abate_privacy_released_total ${counters.releasedTotal}`,
    "# HELP abate_privacy_suppressed_total Normal deterministic suppressions (floor/overlap/residual/quality; not an error)",
    "# TYPE abate_privacy_suppressed_total counter",
    `abate_privacy_suppressed_total ${counters.suppressedTotal}`,
    "# HELP abate_privacy_engine_errors_total Unexpected errors inside the privacy release compiler",
    "# TYPE abate_privacy_engine_errors_total counter",
    `abate_privacy_engine_errors_total ${counters.engineErrorsTotal}`,
    "# HELP abate_worker_queue_depth Current pending outbox events waiting in worker queue",
    "# TYPE abate_worker_queue_depth gauge",
    `abate_worker_queue_depth ${workerMetrics.queueDepth}`,
    "# HELP abate_worker_queue_lag_ms Oldest pending outbox event lag in milliseconds",
    "# TYPE abate_worker_queue_lag_ms gauge",
    `abate_worker_queue_lag_ms ${workerMetrics.queueLagMs}`,
    "# HELP abate_worker_dead_letters_total Outbox events moved to dead-letter state",
    "# TYPE abate_worker_dead_letters_total counter",
    `abate_worker_dead_letters_total ${workerMetrics.totalDeadLetters}`,
    "# HELP abate_dependencies_up Dependency reachability (1=up, 0=down)",
    "# TYPE abate_dependencies_up gauge",
    `abate_dependencies_up{component="database"} ${deps.databaseOk ? 1 : 0}`,
    `abate_dependencies_up{component="object_store"} ${deps.objectStoreOk ? 1 : 0}`,
    "# HELP abate_connectors_stale_total Active source connectors currently in STALE state",
    "# TYPE abate_connectors_stale_total gauge",
    `abate_connectors_stale_total ${operationalSignals.staleConnectors}`,
    "# HELP abate_pack_resolution_failures_total Policy/jurisdiction pack resolution failures (fail-closed)",
    "# TYPE abate_pack_resolution_failures_total counter",
    `abate_pack_resolution_failures_total ${operationalSignals.packResolutionFailuresTotal}`,
    "# HELP abate_ai_budget_utilization_ratio Peak observed monthly AI budget utilization ratio",
    "# TYPE abate_ai_budget_utilization_ratio gauge",
    `abate_ai_budget_utilization_ratio ${operationalSignals.aiBudgetUtilizationRatio}`,
    "# HELP abate_http_rate_limited_total Total HTTP 429 rate-limit refusals across tenants/actors",
    "# TYPE abate_http_rate_limited_total counter",
    `abate_http_rate_limited_total ${operationalSignals.rateLimitedTotal}`
  );

  return `${lines.join("\n")}\n`;
}
