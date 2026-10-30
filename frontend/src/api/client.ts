// frontend/src/api/client.ts

export const BACKEND_URL = typeof window !== "undefined" ? "" : "http://127.0.0.1:5000";

export interface ApiErrorPayload {
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "UNAVAILABLE";
  message: string;
  requestId: string;
}

export class ApiError extends Error {
  public readonly code: ApiErrorPayload["code"];
  public readonly requestId: string;
  public readonly status: number;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message || `API Error: ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code || "UNAVAILABLE";
    this.requestId = payload.requestId || "unknown";
  }
}

export interface ApiRequestOptions extends RequestInit {
  token?: string | null;
  idempotencyKey?: string;
  ifMatch?: string;
}

/**
 * api: Universal API client connecting to Abate backend with safe error decoding
 */
export async function api<T>(endpoint: string, options: ApiRequestOptions = {}): Promise<T> {
  // Use relative endpoint if in browser (Vite proxy forwards /api to backend)
  const url = endpoint.startsWith("http")
    ? endpoint
    : (typeof window !== "undefined" ? endpoint : `http://127.0.0.1:5000${endpoint}`);

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  if (options.ifMatch) {
    headers.set("If-Match", options.ifMatch);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers
    });
  } catch (netErr: any) {
    // Fallback: If proxy request fails, try direct loopback
    if (!endpoint.startsWith("http")) {
      try {
        res = await fetch(`http://127.0.0.1:5000${endpoint}`, {
          ...options,
          headers
        });
      } catch {
        throw new ApiError(0, {
          code: "UNAVAILABLE",
          message: `Cannot reach Abate backend at ${endpoint}.`,
          requestId: "offline"
        });
      }
    } else {
      throw new ApiError(0, {
        code: "UNAVAILABLE",
        message: netErr.message || "Network error",
        requestId: "offline"
      });
    }
  }

  if (!res.ok) {
    let errorData: ApiErrorPayload;
    try {
      errorData = await res.json();
    } catch {
      errorData = {
        code: "UNAVAILABLE",
        message: `HTTP ${res.status}: ${res.statusText}`,
        requestId: "network-error"
      };
    }
    throw new ApiError(res.status, errorData);
  }

  return (await res.json()) as T;
}

export interface SystemHealth {
  status: string;
  app: string;
  version: string;
  environment: string;
  timestamp: string;
  constitutionalBoundaries: Record<string, string>;
}

export interface SystemInfo {
  app: string;
  version: string;
  description: string;
  architecture: Record<string, string>;
  domains: Record<string, string>;
}

export interface TenantInfo {
  id: string;
  name: string;
  region: string;
  jurisdiction_config_ref: string;
  created_at: string;
}

export interface Organization {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
}

export interface AuditEvent {
  id: number;
  tenant_id: string;
  actor_id: string;
  purpose: string;
  command: string;
  resource_type: string;
  resource_id: string;
  resource_version: number;
  result: string;
  evidence_refs: string[];
  occurred_at: string;
}

export interface OutboxDrainReport {
  status: string;
  report: {
    drained: number;
    published: number;
  };
  timestamp: string;
}

export interface TokenResponse {
  token: string;
  tokenType: string;
  expiresIn: string;
  tenantId: string;
  subject: string;
  role: string;
}

export const PRESET_TENANTS = [
  {
    id: "00000000-0000-4000-a000-00000000000a",
    name: "Apex Legal Partners (Tenant A)",
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    region: "eu-west-2",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  },
  {
    id: "00000000-0000-4000-b000-00000000000b",
    name: "Beacon Chambers (Tenant B)",
    subject: "auth0|user-tenant-b-risk-owner",
    role: "RISK_OWNER",
    region: "eu-west-2",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  }
];

export async function requestToken(tenantId: string, subject: string, role = "RISK_OWNER"): Promise<TokenResponse> {
  return api<TokenResponse>("/api/v2/auth/token", {
    method: "POST",
    body: JSON.stringify({ tenantId, subject, role, purpose: "WORKPLACE_RISK_ASSESSMENT" })
  });
}

// ==========================================
// Phase 2: Ingestion & Work-State Ledger
// ==========================================

export interface Connection {
  id: string;
  tenant_id: string;
  source: string;
  contract_id: string;
  state: "ACTIVE" | "PAUSED" | "REVOKED";
  last_success_at: string | null;
  expected_cadence_seconds: number;
  health: "FRESH" | "DELAYED" | "STALE" | "NEVER_SYNCED";
}

export interface IngestReceipt {
  id: string;
  tenant_id: string;
  connection_id: string;
  batch_id: string;
  accepted: number;
  duplicate: number;
  rejected: number;
  conflicted: number;
  received_at: string;
}

export interface WorkFact {
  id: string;
  tenant_id: string;
  connection_id: string;
  source_record_id: string;
  revision: number;
  subject_pseudonym: string;
  start_at: string;
  end_at: string;
  work_tz: string;
  kind: string;
  payload_hash: string;
  receipt_id: string;
  recorded_at: string;
}

export interface ZoikoTimeBatchPayload {
  connectionId: string;
  batchId: string;
  items: Array<{
    recordId: string;
    revision: number;
    subjectRef: string;
    startUtc: string;
    endUtc: string;
    workTz: string;
    kind: "WORK" | "BREAK_UNPAID";
    [key: string]: any;
  }>;
}

export async function fetchConnections(token: string): Promise<Connection[]> {
  return api<Connection[]>("/api/v2/connections", { token });
}

export async function setConnectionState(
  connectionId: string,
  action: "pause" | "resume" | "revoke",
  token: string
): Promise<{ success: boolean; connection: Connection }> {
  return api<{ success: boolean; connection: Connection }>(
    `/api/v2/connections/${connectionId}/${action}`,
    { method: "POST", token }
  );
}

export async function fetchReceipts(token: string): Promise<IngestReceipt[]> {
  return api<IngestReceipt[]>("/api/v2/receipts", { token });
}

export async function fetchWorkFacts(token: string): Promise<WorkFact[]> {
  return api<WorkFact[]>("/api/v2/work-facts", { token });
}

export async function submitZoikoBatch(
  batch: ZoikoTimeBatchPayload,
  token: string
): Promise<IngestReceipt> {
  return api<IngestReceipt>("/api/v2/connectors/zoikotime/batches", {
    method: "POST",
    body: JSON.stringify(batch),
    token
  });
}

// ==========================================
// Phase 3: Deterministic Measurement & Privacy Release
// ==========================================

export interface SemanticQuery {
  metricId: string;
  metricVersion: number;
  cohortRef: string;
  periodStart: string;
  periodEnd: string;
  releaseClass: "CLASS_A" | "CLASS_B";
}

export type ReleaseView =
  | {
    status: "RELEASED";
    releaseId: string;
    metricId: string;
    metricName: string;
    value: number | null;
    unit: string;
    cohortRef: string;
    periodStart: string;
    periodEnd: string;
    quality: "VALID" | "DEGRADED" | "NOT_APPLICABLE" | "PARTIAL";
    releasedAt: string;
    freshness: "FRESH" | "SUPERSEDED" | "REVOKED";
    assuranceLabel: string;
    interpretation?: string;
    limits?: string;
  }
  | {
    status: "STALE";
    releaseId: string;
    reason: string;
    supersededAt?: string;
    asOf?: string;
  }
  | {
    status: "UNAVAILABLE";
    code: "NOT_AVAILABLE";
    message?: string;
  };

export interface MetricDefinition {
  id: string;
  version: number;
  name: string;
  hazard_domain: string;
  formula_id: string;
  contributor_floor: number;
  min_window_days: number;
  created_at: string;
}

export async function queryRelease(
  query: SemanticQuery,
  customCohortMembers?: string[],
  token?: string
): Promise<ReleaseView> {
  return api<ReleaseView>("/api/v2/releases/query", {
    method: "POST",
    body: JSON.stringify({ query, customCohortMembers }),
    token
  });
}

export async function fetchRelease(releaseId: string, token: string): Promise<ReleaseView> {
  return api<ReleaseView>(`/api/v2/releases/${releaseId}`, { token });
}

export async function fetchMetricDefinitions(token: string): Promise<MetricDefinition[]> {
  return api<MetricDefinition[]>("/api/v2/metrics/definitions", { token });
}

export async function recalculateMetric(
  metricId: string,
  token: string
): Promise<{ status: string; count: number }> {
  return api<{ status: string; count: number }>(`/api/v2/metrics/${metricId}/recalculate`, {
    method: "POST",
    token
  });
}

export async function downloadReleaseCsv(releaseId: string, token: string): Promise<string> {
  const url = `/api/v2/releases/${releaseId}/export.csv`;
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Export failed: ${res.statusText}`);
  }
  return res.text();
}

// -------------------------------------------------------------
// Phase 4 Hazard, Control & Verification Types & Client Methods
// -------------------------------------------------------------

export interface Hazard {
  id: string;
  tenant_id: string;
  title: string;
  owner_principal_id: string;
  originating_release_id: string;
  disposition: "OPEN" | "CONTROLLED" | "DEFERRED" | "ACCEPTED" | "VERIFIED_CLOSURE";
  version: number;
  created_at: string;
  causesCount?: number;
  controlsCount?: number;
  allowedActions?: string[];
  dispositionRationale?: string;
  residualRisk?: string;
  reviewDate?: string;
}

export interface Cause {
  id: string;
  hazard_id: string;
  statement: string;
  status: "PROPOSED" | "REVIEWED_ACCEPTED" | "REVIEWED_REJECTED";
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  version: number;
  created_at: string;
}

export interface ControlDetailView {
  id: string;
  tenantId: string;
  hazardId: string;
  causeId: string;
  state: "DRAFT" | "PROPOSED" | "REVIEW_REQUIRED" | "CONSULTATION_REQUIRED" | "APPROVAL_REQUIRED" | "APPROVED" | "SCHEDULED" | "IMPLEMENTING" | "IMPLEMENTED" | "VERIFYING" | "CLOSED" | "REOPENED" | "CANCELLED" | "SUPERSEDED";
  version: number;
  scope: string;
  objective: string;
  ownerPrincipalId: string;
  dueDate: string;
  verificationPlan: any;
  materialHash: string;
  allowedActions: string[];
  applicableGates: Array<{ gate: string; satisfied: boolean }>;
  materialChanges: Array<{ field: string; from: string; to: string }>;
  etag: string;
  approval?: {
    approvedVersion: number;
    approvedMaterialHash: string;
    approverPrincipalId: string;
    approvedAt: string;
  } | null;
  receipt?: {
    kind: string;
    completedOn: string;
    evidenceRefs: string[];
    recordedAt: string;
  } | null;
  evaluation?: {
    plan: any;
    outcome: "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "NOT_EFFECTIVE" | "INCONCLUSIVE" | null;
    reviewerId: string | null;
    residualRisk: string | null;
    concludedAt: string | null;
  } | null;
}

export interface HazardDetail {
  hazard: Hazard;
  causes: Cause[];
  controls: ControlDetailView[];
  originatingRelease: ReleaseView;
}

export interface EvidencePackage {
  manifest: {
    packageId: string;
    hazardId: string;
    tenantId: string;
    cutoff: string;
    issuer: string;
    classification: "RESTRICTED" | "CONFIDENTIAL";
    items: Array<{
      type: string;
      id: string;
      version: number;
      sha256: string;
    }>;
    manifestHash: string;
  };
  artifacts: Array<{
    type: string;
    id: string;
    version: number;
    sha256: string;
    data: any;
  }>;
}

export async function fetchHazards(token: string): Promise<Hazard[]> {
  return api<Hazard[]>("/api/v2/hazards", { token });
}

export async function fetchHazardDetail(hazardId: string, token: string): Promise<HazardDetail> {
  return api<HazardDetail>(`/api/v2/hazards/${hazardId}`, { token });
}

export async function createHazard(
  data: { title: string; originatingReleaseId: string },
  token: string
): Promise<Hazard> {
  return api<Hazard>("/api/v2/hazards", {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function proposeCause(
  hazardId: string,
  statement: string,
  token: string
): Promise<Cause> {
  return api<Cause>(`/api/v2/hazards/${hazardId}/causes`, {
    method: "POST",
    body: JSON.stringify({ statement }),
    token
  });
}

export async function reviewCause(
  hazardId: string,
  causeId: string,
  status: "REVIEWED_ACCEPTED" | "REVIEWED_REJECTED",
  token: string
): Promise<{ id: string; status: string; reviewedBy: string; reviewedAt: string }> {
  return api<{ id: string; status: string; reviewedBy: string; reviewedAt: string }>(
    `/api/v2/hazards/${hazardId}/causes/${causeId}/review`,
    {
      method: "POST",
      body: JSON.stringify({ status }),
      token
    }
  );
}

export async function createControl(
  data: {
    hazardId: string;
    causeId: string;
    scope: string;
    objective: string;
    dueDate: string;
    verificationPlan: any;
  },
  token: string
): Promise<ControlDetailView> {
  return api<ControlDetailView>("/api/v2/controls", {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function fetchControlDetail(controlId: string, token: string): Promise<ControlDetailView> {
  return api<ControlDetailView>(`/api/v2/controls/${controlId}`, { token });
}

export async function updateControl(
  controlId: string,
  data: {
    scope?: string;
    objective?: string;
    dueDate?: string;
    verificationPlan?: any;
  },
  ifMatch: string | number,
  token: string
): Promise<ControlDetailView> {
  return api<ControlDetailView>(`/api/v2/controls/${controlId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    ifMatch: String(ifMatch),
    token
  });
}

export async function approveControl(
  controlId: string,
  ifMatch: string | number,
  token: string
): Promise<ControlDetailView> {
  return api<ControlDetailView>(`/api/v2/controls/${controlId}/approve`, {
    method: "POST",
    ifMatch: String(ifMatch),
    token
  });
}

export async function recordImplementation(
  controlId: string,
  data: {
    kind: string;
    completedOn: string;
    evidenceRefs: string[];
  },
  token: string
): Promise<ControlDetailView> {
  return api<ControlDetailView>(`/api/v2/controls/${controlId}/implementation`, {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function pinVerificationPlan(
  controlId: string,
  plan: {
    primaryMetric: string;
    baselineReleaseId: string;
    targetDelta?: number;
    adjacentReleaseIds?: string[];
    adjacentTolerance?: number;
    minDays?: number;
    seriesBreak?: boolean;
  },
  token: string
): Promise<ControlDetailView> {
  return api<ControlDetailView>(`/api/v2/controls/${controlId}/verification/pin`, {
    method: "POST",
    body: JSON.stringify(plan),
    token
  });
}

export async function concludeVerification(
  controlId: string,
  data: {
    outcome: "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "NOT_EFFECTIVE" | "INCONCLUSIVE";
    residualRisk: string;
  },
  token: string
): Promise<ControlDetailView> {
  return api<ControlDetailView>(`/api/v2/controls/${controlId}/verification/conclude`, {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function setHazardDisposition(
  hazardId: string,
  data: {
    disposition: "OPEN" | "CONTROLLED" | "DEFERRED" | "ACCEPTED" | "VERIFIED_CLOSURE";
    rationale: string;
    residualRisk: string;
    reviewDate: string;
  },
  token: string
): Promise<Hazard> {
  return api<Hazard>(`/api/v2/hazards/${hazardId}/disposition`, {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function exportEvidencePackage(
  hazardId: string,
  token: string
): Promise<EvidencePackage> {
  return api<EvidencePackage>(`/api/v2/hazards/${hazardId}/evidence-package`, {
    method: "POST",
    token
  });
}



// ==========================================
// Phase 5: Jurisdiction Packs, Retention & Legal Hold
// ==========================================

export type DataCategory = "WORK_FACT";

export interface DurationBound {
  days: number;
  citation: string;
}

export interface JurisdictionPack {
  packId: string;
  version: number;
  jurisdiction: string;
  sector: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "APPROVED" | "RETIRED";
  content: {
    title: string;
    sourceRefs: string[];
    retention: Partial<Record<DataCategory, { floor?: DurationBound; ceiling?: DurationBound }>>;
    notes?: string;
  };
  contentHash: string;
  approvedBy: string;
}

export type JurisdictionCoverage =
  | { status: "COVERED"; pack: JurisdictionPack }
  | { status: "NOT_COVERED"; packId: string | null; at: string };

export interface RetentionClass {
  id: string;
  data_category: DataCategory;
  retention_days: number;
  basis: string;
  version: number;
  status: "ACTIVE" | "SUPERSEDED";
  pack_id: string;
  pack_version: number;
  set_by: string;
  created_at: string;
}

export interface LegalHold {
  id: string;
  data_category: DataCategory;
  scope_connection_id: string | null;
  matter_ref: string;
  reason: string;
  placed_by: string;
  placed_at: string;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
}

export type RetentionRunStatus = "COMPLETED" | "NO_POLICY" | "BLOCKED";

export interface RetentionRun {
  id: string;
  data_category: DataCategory;
  status: RetentionRunStatus;
  blocked_reason: string | null;
  retention_class_version: number | null;
  cutoff: string | null;
  eligible: number;
  held: number;
  purged: number;
  verified: number;
  completed_at: string;
}

export interface RetentionRunReceipt {
  runId: string;
  status: RetentionRunStatus;
  blockedReason?: string;
  cutoff: string | null;
  eligible: number;
  held: number;
  purged: number;
  verified: number;
  completedAt: string;
}

export interface RetentionState {
  coverage: JurisdictionCoverage;
  classes: RetentionClass[];
  holds: LegalHold[];
  runs: RetentionRun[];
  tombstones: {
    total: number;
    verified: number;
    recent: Array<{ id: string; runId: string; dataCategory: DataCategory; recordDigest: string; deletedAt: string; verifiedAt: string | null }>;
  };
}

export interface RetentionPreview {
  status: RetentionRunStatus;
  blockedReason: string | null;
  cutoff: string | null;
  eligible: number;
  held: number;
  purgeable: number;
}

export async function fetchRetentionState(token: string): Promise<RetentionState> {
  return api<RetentionState>("/api/v2/retention", { token });
}

export async function fetchPackVersions(token: string): Promise<{ packId: string | null; versions: JurisdictionPack[] }> {
  return api<{ packId: string | null; versions: JurisdictionPack[] }>("/api/v2/jurisdiction/pack-versions", { token });
}

export async function previewRetention(token: string): Promise<RetentionPreview> {
  return api<RetentionPreview>("/api/v2/retention/preview?dataCategory=WORK_FACT", { token });
}

export async function setRetentionClass(
  input: { dataCategory: DataCategory; retentionDays: number; basis: string },
  idempotencyKey: string,
  token: string
): Promise<{ id: string; version: number; retentionDays: number; packId: string; packVersion: number }> {
  return api("/api/v2/retention/classes", {
    method: "POST",
    body: JSON.stringify(input),
    idempotencyKey,
    token
  });
}

export async function runRetention(idempotencyKey: string, token: string): Promise<RetentionRunReceipt> {
  return api<RetentionRunReceipt>("/api/v2/retention/runs", {
    method: "POST",
    body: JSON.stringify({ dataCategory: "WORK_FACT" }),
    idempotencyKey,
    token
  });
}

export async function placeLegalHold(
  input: { dataCategory: DataCategory; scopeConnectionId?: string; matterRef: string; reason: string },
  idempotencyKey: string,
  token: string
): Promise<{ id: string; placedAt: string }> {
  return api("/api/v2/legal-holds", {
    method: "POST",
    body: JSON.stringify(input),
    idempotencyKey,
    token
  });
}

export async function releaseLegalHold(
  holdId: string,
  releaseReason: string,
  idempotencyKey: string,
  token: string
): Promise<{ id: string; releasedAt: string }> {
  return api(`/api/v2/legal-holds/${holdId}/release`, {
    method: "POST",
    body: JSON.stringify({ releaseReason }),
    idempotencyKey,
    token
  });
}

// ==========================================
// B8: SLOs & Zero-Impersonation Support
// ==========================================

export type SloStatus = "MET" | "BREACHED" | "NO_DATA";

export interface SloReport {
  generatedAt: string;
  window: { from: string | null; to: string | null; requests: number };
  latency: Array<{ routeClass: string; targetP95Ms: number; p95Ms: number | null; requests: number; status: SloStatus }>;
  availability: {
    requests: number;
    serverErrors: number;
    ratio: number | null;
    target: number;
    errorBudget: { allowedFailures: number; consumed: number; remaining: number };
    status: SloStatus;
  };
  slowestRoutes: Array<{ route: string; method: string; routeClass: string; p95Ms: number; requests: number }>;
  overall: SloStatus;
  scope: string;
}

export interface OpsRequestRecord {
  requestId: string;
  at: string;
  method: string;
  route: string;
  routeClass: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
  errorFingerprint: string | null;
  errorLog: { errorName: string; fingerprint: string } | null;
}

export interface SafeErrorLogEntry {
  level: "error";
  at: string;
  requestId: string;
  errorName: string;
  fingerprint: string;
}

export interface DiagnosticReceipt {
  receiptId: string;
  schemaVersion: string;
  tenantId: string;
  generatedAt: string;
  sections: Record<string, unknown>;
  excluded: string[];
  signature: string;
}

export async function requestSupportToken(operator: string): Promise<{ token: string; operator: string }> {
  return api("/api/v2/auth/support-token", { method: "POST", body: JSON.stringify({ operator }) });
}

export async function fetchSloReport(supportToken: string): Promise<SloReport> {
  return api<SloReport>("/api/v2/ops/slo", { token: supportToken });
}

export async function fetchOpsErrors(supportToken: string): Promise<SafeErrorLogEntry[]> {
  return api<SafeErrorLogEntry[]>("/api/v2/ops/errors", { token: supportToken });
}

export async function lookupOpsRequest(requestId: string, supportToken: string): Promise<OpsRequestRecord> {
  return api<OpsRequestRecord>(`/api/v2/ops/requests/${encodeURIComponent(requestId)}`, { token: supportToken });
}

export async function issueDiagnosticReceipt(idempotencyKey: string, token: string): Promise<DiagnosticReceipt> {
  return api<DiagnosticReceipt>("/api/v2/support/diagnostic-receipts", { method: "POST", idempotencyKey, token });
}

export async function verifyDiagnosticReceipt(
  receipt: unknown,
  supportToken: string
): Promise<{ valid: boolean; receiptId: string | null; tenantId: string | null; generatedAt: string | null }> {
  return api("/api/v2/ops/diagnostic-receipts/verify", { method: "POST", body: JSON.stringify(receipt), token: supportToken });
}

// ==========================================
// Phase 6: Bounded AI & Safe Action Execution (Domains S08 & S09)
// ==========================================

export interface AiClaim {
  id: string;
  text: string;
  citations: string[];
}

export interface AiProposal {
  title: string;
  claims: AiClaim[];
  uncertainty: string;
  suggestedControls?: string[];
}

export interface ValidatorReport {
  ok: boolean;
  failureCode?: "SCHEMA" | "CITATION" | "NUMERIC_FIDELITY" | "CONTROL_ELIGIBILITY" | "PROHIBITED_INFERENCE" | "REGION_PROVIDER";
  details?: string;
  violations?: string[];
}

export interface AiRunView {
  id: string;
  tenantId: string;
  useCaseKey: string;
  useCaseVersion: number;
  actorId: string;
  contextRefs: Array<{ type: "RELEASE" | "KNOWLEDGE"; id: string }>;
  output?: AiProposal | null;
  status: "PROPOSED" | "REJECTED_BY_VALIDATOR" | "ACCEPTED" | "DISCARDED" | "FAILED";
  validatorReport?: ValidatorReport;
  modelRef: string;
  promptVersion: string;
  tokensIn?: number;
  tokensOut?: number;
  costMinor?: number;
  createdAt: string;
}

export interface KillSwitchRecord {
  scope: string;
  active: boolean;
  changed_by: string | null;
  changed_at: string;
}

export interface ActionAttemptView {
  id: string;
  tenantId: string;
  tool: string;
  target: string;
  paramHash: string;
  resourceVersion: number;
  approvalRef?: string | null;
  effectKey: string;
  state: "PENDING" | "LEASED" | "DISPATCHED" | "SUCCEEDED" | "FAILED" | "UNKNOWN_OUTCOME" | "BLOCKED";
  leaseOwner?: string | null;
  fencingToken: number;
  providerReceipt?: any;
  createdAt: string;
}

export async function explainReleaseAi(
  releaseId: string,
  question?: string,
  token?: string
): Promise<AiRunView> {
  return api<AiRunView>("/api/v2/ai/explain-release", {
    method: "POST",
    body: JSON.stringify({ releaseId, question }),
    token
  });
}

export async function draftCauseAi(
  hazardId: string,
  token?: string
): Promise<AiRunView> {
  return api<AiRunView>("/api/v2/ai/draft-cause", {
    method: "POST",
    body: JSON.stringify({ hazardId }),
    token
  });
}

export async function draftControlAi(
  hazardId: string,
  causeId: string,
  token?: string
): Promise<AiRunView> {
  return api<AiRunView>("/api/v2/ai/draft-control", {
    method: "POST",
    body: JSON.stringify({ hazardId, causeId }),
    token
  });
}

export async function acceptAiRun(
  runId: string,
  options?: { hazardId?: string; causeStatement?: string },
  token?: string
): Promise<{ runId: string; status: "ACCEPTED"; createdResourceId?: string; decisionRef: string }> {
  return api(`/api/v2/ai/runs/${runId}/accept`, {
    method: "POST",
    body: JSON.stringify(options || {}),
    token
  });
}

export async function discardAiRun(
  runId: string,
  token?: string
): Promise<{ runId: string; status: "DISCARDED" }> {
  return api(`/api/v2/ai/runs/${runId}/discard`, {
    method: "POST",
    token
  });
}

export async function fetchAiRuns(token?: string): Promise<AiRunView[]> {
  return api<AiRunView[]>("/api/v2/ai/runs", { token });
}

// Tenant view (read-only). Changing a switch is an ops action: setKillSwitch needs a support-operator token.
export async function fetchKillSwitches(token?: string): Promise<KillSwitchRecord[]> {
  return api<KillSwitchRecord[]>("/api/v2/ai/kill-switches", { token });
}

export async function setKillSwitch(
  scope: string,
  active: boolean,
  supportToken: string
): Promise<KillSwitchRecord> {
  return api<KillSwitchRecord>("/api/v2/ops/kill-switches", {
    method: "POST",
    body: JSON.stringify({ scope, active }),
    token: supportToken
  });
}

export async function proposeAction(
  proposal: { tool: string; target: string; params: Record<string, any>; resourceVersion: number; approvalRef: string },
  token?: string
): Promise<{ attempt: ActionAttemptView; grantToken: string }> {
  return api("/api/v2/actions/proposals", {
    method: "POST",
    body: JSON.stringify(proposal),
    token
  });
}

export async function dispatchAction(
  attemptId: string,
  params: Record<string, any>,
  grantToken: string,
  token?: string
): Promise<{ state: string; fencingToken: number; receipt?: any; error?: string }> {
  return api(`/api/v2/actions/${attemptId}/dispatch`, {
    method: "POST",
    body: JSON.stringify({ params, grantToken }),
    token
  });
}

// Seeded ABATE-GOLDEN-01 fixtures used by the lab screens (Tenant A)
export const BASELINE_RELEASE_ID = "00000000-0000-4000-a003-000000000001";
export const SEEDED_APPROVAL_ID = "00000000-0000-4000-a007-000000000004";
