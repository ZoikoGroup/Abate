// frontend/src/api/client.ts
import {
  OPENAPI_PATHS,
  OPENAPI_SERVER_BASE,
  OPENAPI_SPEC_VERSION,
  type OpenApiMethod,
  type OpenApiPath
} from "./openapi.generated";

export { OPENAPI_PATHS, OPENAPI_SERVER_BASE, OPENAPI_SPEC_VERSION, type OpenApiMethod, type OpenApiPath };

export const BACKEND_URL = typeof window !== "undefined" ? "" : "http://127.0.0.1:5000";

export interface ApiErrorPayload {
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "RATE_LIMITED" | "UNAVAILABLE";
  message: string;
  requestId: string;
  fields?: string[];
}

export class ApiError extends Error {
  public readonly code: ApiErrorPayload["code"];
  public readonly requestId: string;
  public readonly status: number;
  public readonly retryAfter?: string;
  public readonly fields: string[];

  constructor(status: number, payload: ApiErrorPayload, retryAfter?: string) {
    super(payload.message || `API Error: ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code || "UNAVAILABLE";
    this.requestId = payload.requestId || "unknown";
    this.retryAfter = retryAfter;
    this.fields = Array.isArray(payload.fields) ? payload.fields : [];
  }
}

export interface ApiRequestOptions extends RequestInit {
  token?: string | null;
  idempotencyKey?: string;
  ifMatch?: string;
  adminCsrfToken?: string;
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

  if (options.token && options.token !== COOKIE_SESSION_TOKEN) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  if (options.ifMatch) {
    headers.set("If-Match", options.ifMatch);
  }

  if (options.adminCsrfToken) {
    headers.set("X-Admin-Csrf", options.adminCsrfToken);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers
    });
  } catch {
    throw new ApiError(0, {
      code: "UNAVAILABLE",
      message: `Cannot reach Abate backend at ${endpoint}. Ensure the backend service is running.`,
      requestId: "offline"
    });
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
    throw new ApiError(res.status, errorData, res.headers.get("Retry-After") || undefined);
  }

  return (await res.json()) as T;
}

/**
 * Contract-bound API helper typed directly against openapi.generated.ts (Completion Plan §6 & §7.1).
 */
export async function apiV2<T, P extends OpenApiPath>(
  path: P,
  options: ApiRequestOptions = {}
): Promise<T> {
  return api<T>(`${OPENAPI_SERVER_BASE}${path}`, options);
}

export const COOKIE_SESSION_TOKEN = "__ABATE_HTTPONLY_COOKIE_SESSION__";

export interface SystemHealth {
  status: string;
  app: string;
  version: string;
  environment: string;
  timestamp: string;
  constitutionalBoundaries: Record<string, string>;
  database?: { mode: string; required: boolean; ok: boolean };
  objectStore?: { mode: string; ok: boolean; detail: string };
}

export interface OidcConfig {
  devTokenEnabled: boolean;
  oidcConfigured: boolean;
  authorizationEndpoint: string | null;
  clientId: string | null;
  issuer: string;
  audience: string;
  scope: string;
  pkceRequired: boolean;
  pkceMethod: string;
}

export interface OidcExchangeResult {
  authenticated: boolean;
  tenantId: string;
  subject: string;
  role: string;
  expiresIn: string;
  authMethod: string;
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

export async function fetchOidcConfig(): Promise<OidcConfig> {
  return api<OidcConfig>("/api/v2/auth/oidc/config");
}

export async function fetchCurrentPrincipal(token?: string | null): Promise<{
  principalId: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  role: string;
  allowedNav?: string[];
  allowedActions?: string[];
}> {
  return apiV2("/me", { token });
}

export async function exchangeOidcAuth(body: {
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  idToken?: string;
}): Promise<OidcExchangeResult> {
  return api<OidcExchangeResult>("/api/v2/auth/oidc/exchange", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export async function logoutSession(): Promise<void> {
  await fetch("/api/v2/auth/logout", {
    method: "POST",
    credentials: "same-origin"
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createPkceAuthorizationParams(): Promise<{
  state: string;
  verifier: string;
  challenge: string;
}> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = toBase64Url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = toBase64Url(new Uint8Array(digest));
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = toBase64Url(stateBytes);
  return { state, verifier, challenge };
}

// ==========================================
// Phase 2: Ingestion & Work-State Ledger
// ==========================================

export interface SourceContract {
  id: string;
  tenant_id: string;
  source: "ZoikoTime" | "CalendarCadence";
  version: string;
  contract_hash: string;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
}

export type ConnectionStateValue = "ACTIVE" | "PAUSED" | "SUSPENDED" | "RESUMED" | "DISCONNECTED" | "REVOKED";

export interface Connection {
  id: string;
  tenant_id: string;
  source: string;
  contract_id: string;
  state: ConnectionStateValue;
  stateLabel?: string;
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

export async function fetchSourceContracts(token: string): Promise<SourceContract[]> {
  return api<SourceContract[]>("/api/v2/source-contracts", { token });
}

export async function fetchConnections(token: string): Promise<Connection[]> {
  return api<Connection[]>("/api/v2/connections", { token });
}

export async function registerConnection(
  payload: {
    source: "ZoikoTime" | "CalendarCadence";
    contractId: string;
    expectedCadenceSeconds?: number;
  },
  idempotencyKey: string,
  token: string
): Promise<Connection> {
  return api<Connection>("/api/v2/connections", {
    method: "POST",
    token,
    idempotencyKey,
    body: JSON.stringify(payload)
  });
}

export function formatConnectionStateLabel(state: Connection["state"]): string {
  switch (state) {
    case "ACTIVE":
      return "Active";
    case "PAUSED":
      return "Paused";
    case "SUSPENDED":
      return "Suspended";
    case "RESUMED":
      return "Resumed";
    case "DISCONNECTED":
    case "REVOKED":
      return "Disconnected";
    default:
      return state;
  }
}

export async function setConnectionState(
  connectionId: string,
  action: "pause" | "resume" | "suspend" | "disconnect" | "revoke",
  token: string
): Promise<Connection> {
  return api<Connection>(
    `/api/v2/connections/${connectionId}/${action}`,
    {
      method: "POST",
      token,
      idempotencyKey: `conn-${action}-${crypto.randomUUID()}`
    }
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
  if (token && token !== COOKIE_SESSION_TOKEN) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(url, { credentials: "same-origin", headers });
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
    baselineReleaseId: string;
    postReleaseId?: string;
    adjacentReleaseIds?: string[];
    direction?: "DECREASE" | "INCREASE";
    criteria?: number;
    adjacentTolerance?: number;
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
    postReleaseId: string;
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

// A JURISDICTION pack from the single policy_pack catalog, reached through the tenant's binding
export interface JurisdictionPack {
  packKey: string;
  version: number;
  kind: "JURISDICTION" | "SECTOR" | "CUSTOMER";
  title: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "DRAFT" | "APPROVED" | "WITHDRAWN";
  retention: Partial<Record<DataCategory, { floor?: DurationBound; ceiling?: DurationBound }>> | null;
  sourceRefs: string[];
  accountableReviewer: string;
  contentHash: string;
}

export type JurisdictionCoverage =
  | { status: "COVERED"; pack: JurisdictionPack }
  | { status: "NOT_COVERED"; reason: string; boundPackKeys: string[]; at: string };

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
  /** Neutral case reference. */
  case_ref?: string;
  /** Deprecated alias of case_ref. */
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

export async function fetchPackVersions(token: string): Promise<{ packKeys: string[]; versions: JurisdictionPack[] }> {
  return api<{ packKeys: string[]; versions: JurisdictionPack[] }>("/api/v2/jurisdiction/pack-versions", { token });
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
  input: { dataCategory: DataCategory; scopeConnectionId?: string; caseRef: string; reason: string },
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
  reason?: string | null;
  canToggle?: boolean;
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
  token?: string,
  idempotencyKey?: string
): Promise<AiRunView> {
  return api<AiRunView>("/api/v2/ai/explain-release", {
    method: "POST",
    body: JSON.stringify({ releaseId, question }),
    token,
    idempotencyKey
  });
}

export async function draftCauseAi(
  hazardId: string,
  token?: string,
  idempotencyKey?: string
): Promise<AiRunView> {
  return api<AiRunView>("/api/v2/ai/draft-cause", {
    method: "POST",
    body: JSON.stringify({ hazardId }),
    token,
    idempotencyKey
  });
}

export async function draftControlAi(
  hazardId: string,
  causeId: string,
  token?: string,
  idempotencyKey?: string
): Promise<AiRunView> {
  return api<AiRunView>("/api/v2/ai/draft-control", {
    method: "POST",
    body: JSON.stringify({ hazardId, causeId }),
    token,
    idempotencyKey
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

export async function fetchKillSwitchesOps(supportToken: string): Promise<KillSwitchRecord[]> {
  return api<KillSwitchRecord[]>("/api/v2/ops/kill-switches", { token: supportToken });
}

export async function setKillSwitch(
  scope: string,
  active: boolean,
  supportToken: string,
  reason?: string
): Promise<KillSwitchRecord> {
  const payload: { scope: string; active: boolean; reason?: string } = { scope, active };
  if (reason && reason.trim().length >= 5) {
    payload.reason = reason.trim();
  }
  return api<KillSwitchRecord>("/api/v2/ops/kill-switches", {
    method: "POST",
    body: JSON.stringify(payload),
    token: supportToken
  });
}

export async function fetchReleaseDossier(): Promise<any | null> {
  try {
    return await apiV2<any, "/release/dossier">("/release/dossier");
  } catch {
    try {
      return await api<any>("/release-dossier.json");
    } catch {
      return null;
    }
  }
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

// ==========================================
// Phase 7: Outcomes & AI Change (Package B7)
// ==========================================

export type AutomationMode = "ASSIST" | "AUTOMATE_WITH_REVIEW" | "AUTONOMOUS_BOUNDED";
export type AiChangeStage =
  | "REGISTERED"
  | "BASELINE"
  | "DETECT"
  | "ATTRIBUTE"
  | "CONTROL"
  | "VERIFY"
  | "PERFORMANCE_REVIEW"
  | "CLOSED";

export interface OutcomeDefinitionView {
  outcomeId: string;
  version: number;
  outcomeClass: "COMPLIANCE_EVIDENCE" | "PERFORMANCE_OUTCOME";
  family: "WORKLOAD_SUSTAINABILITY" | "ROLE_CLARITY" | "FRAGMENTATION" | "HUMAN_AI_WORK_QUALITY";
  purpose: string;
  prohibitedInterpretation: string;
  unit: string;
  definition: Record<string, any>;
  qualityRules: Record<string, any>;
  privacyClass: string;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  definitionHash: string;
}

export interface OutcomeEvaluationView {
  id: string;
  tenantId: string;
  outcomeId: string;
  outcomeVersion: number;
  interventionId?: string;
  comparisonBasis: Record<string, any>;
  confounders: Record<string, any>;
  seriesBreak: boolean;
  outcomeConfidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";
  permittedClaims: string[];
  evidenceRefs: string[];
  releaseId: string;
  plane: "B";
  createdAt: string;
}

export interface FeatureFlagView {
  flag: string;
  enabled: boolean;
  tenantId: string | null;
  changedBy?: string;
  changedAt?: string;
}

export interface AiChangeProfileView {
  id: string;
  tenantId: string;
  title: string;
  version: number;
  affectedRoles: string[];
  affectedTasks: string[];
  automationMode: AutomationMode;
  decisionRights: string;
  humanOverride: string;
  monitoringChanges: string;
  throughputAssumptions: string;
  rolloutDate: string;
  trainingSupport: string;
}

export interface AiWorkDesignAssessmentView {
  id: string;
  tenantId: string;
  profileId: string;
  profileVersion: number;
  stage: AiChangeStage;
  hazardIds: string[];
  controlIds: string[];
  baselineReleaseIds: string[];
  verificationRefs: string[];
  version: number;
  profile?: AiChangeProfileView;
  assuranceSummary?: {
    openHazardsCount: number;
    pendingControlsCount: number;
    verifiedControlsCount: number;
  };
  performanceSummary?: {
    evaluationsCount: number;
    permittedClaims: string[];
  };
}

export async function fetchFeatureFlags(token?: string): Promise<Record<string, boolean>> {
  const res = await api<any>("/api/v2/flags", { token });
  const map: Record<string, boolean> = {
    outcomes_plane_b: false,
    ai_change_assessment: false
  };
  if (Array.isArray(res)) {
    for (const item of res) {
      if (item && item.flag) {
        map[item.flag] = Boolean(item.enabled);
      }
    }
  } else if (res && typeof res === "object") {
    for (const [k, v] of Object.entries(res)) {
      map[k] = Boolean(v);
    }
  }
  return map;
}

export async function setFeatureFlag(flag: string, enabled: boolean, token?: string): Promise<FeatureFlagView> {
  return api<FeatureFlagView>("/api/v2/flags", {
    method: "POST",
    body: JSON.stringify({ flag, enabled }),
    token
  });
}

export async function fetchOutcomeDefinitions(token?: string): Promise<OutcomeDefinitionView[]> {
  return api<OutcomeDefinitionView[]>("/api/v2/outcomes/definitions", { token });
}

export async function createOutcomeDefinition(data: any, token?: string): Promise<OutcomeDefinitionView> {
  return api<OutcomeDefinitionView>("/api/v2/outcomes/definitions", {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function approveOutcomeDefinition(id: string, token?: string): Promise<OutcomeDefinitionView> {
  return api<OutcomeDefinitionView>(`/api/v2/outcomes/definitions/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
    token
  });
}

export async function evaluateOutcome(data: any, token?: string): Promise<OutcomeEvaluationView> {
  return api<OutcomeEvaluationView>("/api/v2/outcomes/evaluations", {
    method: "POST",
    body: JSON.stringify(data),
    token
  });
}

export async function fetchOutcomeEvaluations(token?: string): Promise<OutcomeEvaluationView[]> {
  return api<OutcomeEvaluationView[]>("/api/v2/outcomes/evaluations", { token });
}

export async function fetchOutcomeEvaluation(id: string, token?: string): Promise<OutcomeEvaluationView> {
  return api<OutcomeEvaluationView>(`/api/v2/outcomes/evaluations/${id}`, { token });
}

export async function fetchPlaneBRelease(id: string, token?: string): Promise<any> {
  return api<any>(`/api/v2/outcomes/releases/${id}`, { token });
}

export async function createAiChange(
  profile: any,
  token?: string
): Promise<{ profile: AiChangeProfileView; assessment: AiWorkDesignAssessmentView }> {
  return api<{ profile: AiChangeProfileView; assessment: AiWorkDesignAssessmentView }>("/api/v2/ai-changes", {
    method: "POST",
    body: JSON.stringify(profile),
    token
  });
}

export async function fetchAiAssessments(token?: string): Promise<AiWorkDesignAssessmentView[]> {
  return api<AiWorkDesignAssessmentView[]>("/api/v2/ai-changes", { token });
}

export async function fetchAiAssessment(id: string, token?: string): Promise<AiWorkDesignAssessmentView> {
  return api<AiWorkDesignAssessmentView>(`/api/v2/ai-changes/${id}`, { token });
}

export async function advanceAiAssessment(
  id: string,
  toStage: AiChangeStage,
  version: number,
  data?: { hazardIds?: string[]; controlIds?: string[]; baselineReleaseIds?: string[]; verificationRefs?: string[] },
  token?: string
): Promise<AiWorkDesignAssessmentView> {
  return api<AiWorkDesignAssessmentView>(`/api/v2/ai-changes/${id}/advance`, {
    method: "POST",
    headers: { "if-match": `"${version}"` },
    body: JSON.stringify({ to: toStage, ...data }),
    token
  });
}

// -------------------------------------------------------------
// Sector Pack Client: work items for the tenant's active sector pack
// -------------------------------------------------------------

export interface SectorWorkItemView {
  externalRef: string;
  title: string;
  unit: string;
  demandWindow: string;
  jurisdiction?: string;
  accountableReviewerId: string;
  activeWindowStart: string;
  activeWindowEnd: string;
}

export interface SectorRuleSummary {
  ruleId: string;
  title: string;
  type: string;
  requiredGate: "APPROVAL" | "CONSULTATION" | "REVIEW";
  citationStatus: "APPROVED" | "PREVIEW_PLACEHOLDER";
  reference: string;
  rationale: string;
}

export interface SectorRuleFindingView {
  ruleId: string;
  title: string;
  type: string;
  triggered: boolean;
  observedValue: number;
  thresholdValue: number;
  unit: string;
  requiredGate: "APPROVAL" | "CONSULTATION" | "REVIEW";
  citationStatus: "APPROVED" | "PREVIEW_PLACEHOLDER";
  reference: string;
  rationale: string;
}

export interface JurisdictionOverlayView {
  overlayKey: string | null;
  jurisdictionCode: string | null;
  overlayStatus?: "APPROVED" | "PREVIEW_PLACEHOLDER" | "DRAFT" | "EXPIRED" | "UNBOUND";
  approvalStatus?: "APPROVED" | "DRAFT" | "PREVIEW_PLACEHOLDER";
  supportsComplianceClaim?: boolean;
  accountableReviewer: string | null;
  reviewDate: string | null;
  statutoryReferences: string[];
  consultationGates: Array<"APPROVAL" | "CONSULTATION" | "REVIEW">;
  retentionNote: string;
}

export interface SectorFatigueAssessmentView {
  sectorKey: string;
  workItemId: string;
  unit: string;
  demandWindow: string;
  hasFatigueSurge: boolean;
  consecutiveLateNightsCount: number;
  thresholdUsed: number;
  statutoryReference: string;
  applicableGate: string;
  regulatoryNotice: string;
  ruleFindings?: SectorRuleFindingView[];
  jurisdictionOverlay?: JurisdictionOverlayView;
}

export async function fetchSectorWorkItems(token?: string): Promise<SectorWorkItemView[]> {
  const res = await api<{ items: SectorWorkItemView[] }>("/api/v2/sector/work-items", { token });
  return res.items || [];
}

export async function checkSectorFatigue(
  workItemId: string,
  token?: string,
  intervals?: any[],
  opts?: { jurisdictionCode?: string; simulatedItem?: { unit?: string; demandWindow?: string } }
): Promise<SectorFatigueAssessmentView> {
  return api<SectorFatigueAssessmentView>("/api/v2/sector/work-items/fatigue-check", {
    method: "POST",
    body: JSON.stringify({
      workItemId,
      intervals,
      jurisdictionCode: opts?.jurisdictionCode,
      simulatedItem: opts?.simulatedItem
    }),
    token
  });
}

export async function mapSectorWorkItem(item: any, token?: string): Promise<any> {
  return api<any>("/api/v2/sector/work-items/map", {
    method: "POST",
    body: JSON.stringify(item),
    token
  });
}

// -------------------------------------------------------------
// Principal, Tenancy and Async Operations Client (Guide §D.1 & §C.6)
// -------------------------------------------------------------

export interface PrincipalProfileView {
  principalId: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  purpose: string;
  role: string;
  memberships: Array<{
    organizationId: string;
    domainRole: string;
  }>;
  allowedNav: string[];
}

export interface TenantWorkspaceItem {
  id: string;
  tenantId: string;
  name: string;
  region: string;
  state: "ACTIVE" | "SUSPENDED" | "PROVISIONING";
  cohortSize: number;
}

export interface AsyncJobView {
  id: string;
  tenantId?: string;
  type: string;
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  progress: number;
  result?: any;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpsJobsOverview {
  workerId?: string;
  workerState?: string;
  heartbeatAt?: string;
  queueDepth: number;
  queueLagMs?: number;
  totalProcessed?: number;
  totalFailures?: number;
  totalDeadLetters?: number;
  lastOutboxPruneAt?: string | null;
  outboxPrunedTotal?: number;
  activeWorkers: number;
  items: Array<{
    id: string;
    outboxId?: string;
    type: string;
    state: string;
    attempts?: number;
    lastError?: string;
    progress?: number;
    ageSeconds?: number;
    durationMs?: number;
    createdAt?: string;
    updatedAt?: string;
    publishedAt?: string;
  }>;
}

export async function fetchMe(token?: string): Promise<PrincipalProfileView> {
  return api<PrincipalProfileView>("/api/v2/me", { token });
}

export async function fetchTenants(token?: string): Promise<TenantWorkspaceItem[]> {
  const res = await api<{ items: TenantWorkspaceItem[] }>("/api/v2/tenants", { token });
  return res.items || [];
}

export async function fetchTenantById(id: string, token?: string): Promise<any> {
  return api<any>(`/api/v2/tenants/${id}`, { token });
}

export async function logoutUser(token?: string): Promise<void> {
  await api<void>("/api/v2/auth/logout", {
    method: "POST",
    token
  });
}

export async function refreshToken(token?: string): Promise<{ token: string; expiresIn: string }> {
  return api<{ token: string; expiresIn: string }>("/api/v2/auth/refresh", {
    method: "POST",
    token
  });
}

export async function fetchAsyncJob(id: string, token?: string): Promise<AsyncJobView> {
  return api<AsyncJobView>(`/api/v2/jobs/${id}`, { token });
}

export async function fetchOpsJobs(token?: string): Promise<OpsJobsOverview> {
  return api<OpsJobsOverview>("/api/v2/ops/jobs", { token });
}

export async function replayDeadLetter(
  id: string,
  reason: string,
  token: string
): Promise<{ deadLetterId: string; outboxId: string; replayedBy: string; reason: string; state: "PENDING" }> {
  return api(`/api/v2/ops/dead-letters/${encodeURIComponent(id)}/replay`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    token
  });
}

export interface SectorUiCopy {
  navLabel: string;
  sectorBadge: string;
  badges: string[];
  heading: string;
  subtitle: string;
  panelTitle: string;
  panelDescription: string;
  mandatoryNote: string;
  boundaryTitle: string;
  boundaryText: string;
  listTitle: string;
  unitFilterLabel: string;
  allUnitsLabel: string;
  unitLabels: Record<string, string>;
  fatigueButtonLabel: string;
  fatigueCardTitle: string;
  surgeBadge: string;
  compliantBadge: string;
  thresholdNote: string;
  consultationTitle: string;
  consultationSignerLabel: string;
  consultationSignerDefault: string;
  consultationActions: Array<{ value: string; label: string }>;
  decoyFields: Array<{ field: string; label: string; value: string | number }>;
}

export interface TenantSectorProfile {
  tenantId: string;
  /** Registered sector key, for example GENERIC, LEGAL or ACCOUNTING. Any registered sector may appear. */
  sectorKey: string;
  packKey?: string;
  packStatus?: "BASELINE" | "LAUNCHED" | "PREVIEW" | "FIXTURE";
  displayName?: string;
  /** True when a sector pack other than the neutral baseline is active. */
  packActive?: boolean;
  /** Deprecated: use sectorKey === "LEGAL". */
  hasLegalPack: boolean;
  activePacks: string[];
  vocabulary: {
    workItem: string;
    workItems: string;
    unit: string;
    demandWindow: string;
    supervisor: string;
  };
  demandWindows: string[];
  highDemandWindows?: string[];
  workItemUnits?: string[];
  rules?: SectorRuleSummary[];
  jurisdictionOverlays?: JurisdictionOverlayView[];
  /** Screen wording authored by the sector pack. Optional so older backends still render. */
  ui?: SectorUiCopy;
  claimScope: string;
  enabledSectors: string[];
  availableSectors?: Array<{
    sectorKey: string;
    packKey: string;
    displayName: string;
    status: "BASELINE" | "LAUNCHED" | "PREVIEW" | "FIXTURE";
  }>;
}

export async function fetchTenantSectorProfile(token: string): Promise<TenantSectorProfile> {
  return api<TenantSectorProfile>("/api/v2/tenant/sector-profile", { token });
}

export interface AiQuotaUseCaseStatus {
  useCaseKey: string;
  version: number;
  modelRef: string;
  enabled: boolean;
  monthlyBudgetMinor: number;
  spentMinor: number;
  remainingMinor: number;
  estimatedRunCostMinor: number;
  remainingRunsEst: number;
  windowStart: string;
  resetAt: string;
  killSwitchActive: boolean;
}

export interface AiQuotaStatus {
  tenantId: string;
  window: "CALENDAR_MONTH_UTC";
  windowStart: string;
  resetAt: string;
  allAiDisabled: boolean;
  useCases: AiQuotaUseCaseStatus[];
}

export async function fetchAiQuota(token: string): Promise<AiQuotaStatus> {
  return api<AiQuotaStatus>("/api/v2/ai/quota", { token });
}

export async function fetchOpsAiQuota(supportToken: string, tenantId?: string): Promise<AiQuotaStatus[]> {
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  const res = await api<{ items: AiQuotaStatus[] }>(`/api/v2/ops/ai-quota${qs}`, { token: supportToken });
  return res.items || [];
}

export interface TenantEntitlementsView {
  tenantId: string;
  entitlements: {
    plan: string;
    features: string[];
    [key: string]: unknown;
  };
}

export interface PolicyResolutionResult {
  allowed: boolean;
  entitled?: boolean;
  policyAllowed?: boolean;
  reason?: string | null;
  appliedPacks?: Array<{ packKey: string; version: number; kind?: string }>;
  resolution?: Record<string, unknown>;
}

export interface RightsRequestReceipt {
  requestId: string;
  status: "COMPLETED";
  deleted: number;
  verified: number;
  heldExceptions: number;
  completedAt: string;
}

export async function fetchEntitlements(token: string): Promise<TenantEntitlementsView> {
  return apiV2<TenantEntitlementsView, "/entitlements">("/entitlements", { token });
}

export async function fetchPolicyResolution(feature: string, token: string): Promise<PolicyResolutionResult> {
  return api<PolicyResolutionResult>(`/api/v2/policy/resolution?feature=${encodeURIComponent(feature)}`, { token });
}

export async function updateTenantSectorProfile(
  body: { sectorKey: string; packKey: string },
  idempotencyKey: string,
  token: string
): Promise<TenantSectorProfile> {
  return apiV2<TenantSectorProfile, "/tenant/sector-profile">("/tenant/sector-profile", {
    method: "PUT",
    body: JSON.stringify(body),
    idempotencyKey,
    token
  });
}

export async function submitRightsRequest(
  subjectPseudonym: string,
  idempotencyKey: string,
  token: string
): Promise<RightsRequestReceipt> {
  return apiV2<RightsRequestReceipt, "/lifecycle/rights-requests">("/lifecycle/rights-requests", {
    method: "POST",
    body: JSON.stringify({ subjectPseudonym }),
    idempotencyKey,
    token
  });
}

// ==========================================
// Super Admin Platform Management (/api/v2/admin/*)
// ==========================================

export interface SuperAdminTokenResponse {
  token: string;
  tokenType: "Bearer";
  expiresIn: string;
  operator: string;
  role: "SUPER_ADMIN";
  scope: "platform-super-admin";
  expiresInSeconds?: number;
  stepUpWindowSeconds?: number;
  stepUpVerified?: boolean;
  csrfToken?: string;
}

export interface AdminMeProfile {
  operator: string;
  role: string;
  scope: string;
  authMethod: string;
  mfaVerified: boolean;
  stepUpVerified: boolean;
  stepUpWindowSeconds: number;
  stepUpExpiresAt: string | null;
  sessionExpiresAt: string | null;
  banner: string;
  perimeter: string;
  allowedNav: string[];
  allowedActions: string[];
}

export interface AdminOverview {
  operator: string;
  role: string;
  perimeter: string;
  sloEvidenceState?: "ASSUMPTION" | "MEASURED";
  system: {
    appEnv: string;
    databaseOk: boolean;
    databaseRequired: boolean;
    objectStoreOk: boolean;
    objectStoreMode: string;
    workerState: string;
    workerHeartbeatAt: string | null;
  };
  counts: {
    totalTenants: number;
    activeTenants: number;
    suspendedTenants: number;
    platformAuditCount: number;
    pendingApprovals?: number;
    pendingOutbox: number;
    deadLetterCount: number;
  };
  slo: SloReport;
  alerts: Array<{ id: string; severity: string; state?: string; firing?: boolean; summary?: string; message?: string }>;
  alertSummary?: { overallStatus: string; firingCount: number; criticalCount: number; warningCount: number };
}

export interface AdminTenantRecord {
  id: string;
  name: string;
  region: string;
  state: "ACTIVE" | "SUSPENDED";
  version: number;
  jurisdictionConfigRef: string | null;
  sectorKey: string;
  packKey: string;
  offboardRequestedAt?: string | null;
  offboardReason?: string | null;
  createdAt?: string;
}

export interface AdminPrincipalMembership {
  membershipId: string;
  principalId: string;
  pseudonymousId: string;
  maskedSubject: string;
  kind: "USER" | "WORKLOAD";
  domainRole: string;
  organizationId: string;
  validFrom: string;
  validTo: string | null;
  version: number;
  principalActive?: boolean;
  active: boolean;
}

export interface AdminPlatformUser {
  id: string;
  subject: string;
  displayName: string;
  platformRole: "SUPER_ADMIN" | "OPS_SUPPORT";
  status: "ACTIVE" | "DISABLED";
  breakGlass: boolean;
  mfaEnforced: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface AdminApprovalRequestRecord {
  id: string;
  actionType: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "EXPIRED";
  approvedBy: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  executedAt: string | null;
  expiresAt: string;
  requestId: string | null;
  version: number;
}

export interface AdminPlatformAuditEvent {
  id: string;
  occurred_at: string;
  operator: string;
  approver?: string | null;
  role: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  request_id?: string | null;
  step_up_verified?: boolean;
  details: Record<string, unknown>;
}

export interface AdminGovernancePack {
  sectorKey: string;
  packKey: string;
  displayName: string;
  status: string;
  enableable?: boolean;
  statusLabel?: string;
  version: string;
  reviewStatus: string;
  permittedClaims: string[] | string;
  restrictions: string[];
}

export interface AdminFeatureFlagRecord {
  tenant_id: string | null;
  flag: string;
  enabled: boolean;
  changed_by: string | null;
  changed_at: string;
}

export interface AdminEntitlementRecord {
  tenantId: string;
  featureKey: string;
  enabled: boolean;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: string;
  version: number;
}

export interface AdminAiQuotaRecord {
  tenantId: string;
  tenantName: string;
  tenantState: string;
  monthlyBudgetMinor: number;
  updatedBy: string | null;
  updatedAt: string | null;
  version: number;
}

export interface AdminOperationsOverview {
  worker: {
    workerId: string;
    state: string;
    heartbeatAt: string | null;
    queueLagMs: number;
    totalProcessed: number;
    totalFailures: number;
  };
  queueDepth: number;
  deadLetterCount: number;
  connectors: Array<{ id: string; source: string; state: string; health: string; lastSuccessAt: string | null }>;
}

export async function requestSuperAdminToken(operator: string, stepUp = false): Promise<SuperAdminTokenResponse> {
  return api<SuperAdminTokenResponse>("/api/v2/auth/super-admin-token", {
    method: "POST",
    body: JSON.stringify({ operator, stepUp })
  });
}

export async function verifyAdminStepUp(
  confirmation: string,
  adminToken: string,
  mfaCode?: string
): Promise<{ token: string; csrfToken: string; operator: string; stepUpAt: number; stepUpExpiresAt: string; stepUpWindowSeconds: number }> {
  return api("/api/v2/admin/session/step-up", {
    method: "POST",
    body: JSON.stringify(mfaCode ? { confirmation, mfaCode } : { confirmation }),
    token: adminToken
  });
}

export async function fetchAdminMe(adminToken: string): Promise<AdminMeProfile> {
  return api<AdminMeProfile>("/api/v2/admin/me", { token: adminToken });
}

export async function fetchAdminOverview(adminToken: string): Promise<AdminOverview> {
  return api<AdminOverview>("/api/v2/admin/overview", { token: adminToken });
}

export async function fetchAdminTenants(adminToken: string): Promise<{ items: AdminTenantRecord[] }> {
  return api<{ items: AdminTenantRecord[] }>("/api/v2/admin/tenants", { token: adminToken });
}

export async function createAdminTenant(
  body: { name: string; region: string; sectorKey: string; jurisdictionConfigRef?: string; reason: string },
  adminToken: string
): Promise<AdminTenantRecord> {
  return api<AdminTenantRecord>("/api/v2/admin/tenants", {
    method: "POST",
    body: JSON.stringify(body),
    token: adminToken
  });
}

export async function updateAdminTenant(
  tenantId: string,
  body: { name: string; region: string; jurisdictionConfigRef?: string | null; reason: string },
  adminToken: string,
  version?: number
): Promise<AdminTenantRecord> {
  return api<AdminTenantRecord>(`/api/v2/admin/tenants/${encodeURIComponent(tenantId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    token: adminToken,
    ifMatch: version ? String(version) : undefined
  });
}

export async function setAdminTenantState(
  tenantId: string,
  state: "ACTIVE" | "SUSPENDED",
  reason: string,
  adminToken: string,
  version?: number
): Promise<{ id?: string; state?: "ACTIVE" | "SUSPENDED"; status?: string; approvalRequest?: AdminApprovalRequestRecord }> {
  return api(
    `/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/state`,
    {
      method: "POST",
      body: JSON.stringify({ state, reason }),
      token: adminToken,
      ifMatch: version ? String(version) : undefined
    }
  );
}

export async function requestAdminTenantOffboard(
  tenantId: string,
  reason: string,
  adminToken: string,
  version?: number
): Promise<{ status: string; note: string; approvalRequest: AdminApprovalRequestRecord }> {
  return api(
    `/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/offboard-request`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
      token: adminToken,
      ifMatch: version ? String(version) : undefined
    }
  );
}

export async function setAdminTenantSectorPack(
  tenantId: string,
  sectorKey: string,
  reason: string,
  adminToken: string,
  version?: number
): Promise<{ tenantId?: string; sectorKey?: string; packKey?: string; status?: string; approvalRequest?: AdminApprovalRequestRecord }> {
  return api(
    `/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/sector-pack`,
    {
      method: "PUT",
      body: JSON.stringify({ sectorKey, reason }),
      token: adminToken,
      ifMatch: version ? String(version) : undefined
    }
  );
}

export async function fetchAdminTenantPrincipals(
  tenantId: string,
  adminToken: string
): Promise<{ tenantId: string; privacyMode: string; items: AdminPrincipalMembership[] }> {
  return api<{ tenantId: string; privacyMode: string; items: AdminPrincipalMembership[] }>(
    `/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/principals`,
    { token: adminToken }
  );
}

export async function assignAdminMembership(
  tenantId: string,
  body: {
    externalSubject: string;
    kind: "USER" | "WORKLOAD";
    domainRole: string;
    reason: string;
  },
  adminToken: string
): Promise<AdminPrincipalMembership> {
  return api<AdminPrincipalMembership>(
    `/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/memberships`,
    {
      method: "POST",
      body: JSON.stringify(body),
      token: adminToken
    }
  );
}

export async function revokeAdminMembership(
  tenantId: string,
  membershipId: string,
  reason: string,
  adminToken: string,
  version?: number
): Promise<{ membershipId: string; revoked: boolean }> {
  return api<{ membershipId: string; revoked: boolean }>(
    `/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/memberships/${encodeURIComponent(membershipId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
      token: adminToken,
      ifMatch: version ? String(version) : undefined
    }
  );
}

export async function fetchAdminPlatformUsers(adminToken: string): Promise<{ items: AdminPlatformUser[] }> {
  return api<{ items: AdminPlatformUser[] }>("/api/v2/admin/platform-users", { token: adminToken });
}

export async function createAdminPlatformUser(
  body: { subject: string; displayName: string; platformRole: "SUPER_ADMIN" | "OPS_SUPPORT"; breakGlass?: boolean; reason: string },
  adminToken: string
): Promise<any> {
  return api("/api/v2/admin/platform-users", {
    method: "POST",
    body: JSON.stringify(body),
    token: adminToken
  });
}

export async function updateAdminPlatformUserRole(
  userId: string,
  platformRole: "SUPER_ADMIN" | "OPS_SUPPORT",
  reason: string,
  adminToken: string,
  version?: number
): Promise<any> {
  return api(`/api/v2/admin/platform-users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    body: JSON.stringify({ platformRole, reason }),
    token: adminToken,
    ifMatch: version ? String(version) : undefined
  });
}

export async function disableAdminPlatformUser(
  userId: string,
  reason: string,
  adminToken: string,
  version?: number
): Promise<any> {
  return api(`/api/v2/admin/platform-users/${encodeURIComponent(userId)}/disable`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    token: adminToken,
    ifMatch: version ? String(version) : undefined
  });
}

export async function fetchAdminApprovals(adminToken: string): Promise<{ items: AdminApprovalRequestRecord[] }> {
  return api<{ items: AdminApprovalRequestRecord[] }>("/api/v2/admin/approvals", { token: adminToken });
}

export async function decideAdminApproval(
  approvalId: string,
  mode: "APPROVE" | "REJECT",
  reason: string,
  adminToken: string,
  version?: number
): Promise<any> {
  const url =
    mode === "APPROVE"
      ? `/api/v2/admin/approvals/${encodeURIComponent(approvalId)}/approve`
      : `/api/v2/admin/approvals/${encodeURIComponent(approvalId)}/reject`;
  return api(url, {
    method: "POST",
    body: JSON.stringify({ reason }),
    token: adminToken,
    ifMatch: version ? String(version) : undefined
  });
}

export async function fetchAdminGovernance(adminToken: string): Promise<{ sectorPacks: AdminGovernancePack[] }> {
  return api<{ sectorPacks: AdminGovernancePack[] }>("/api/v2/admin/governance", { token: adminToken });
}

export async function fetchAdminFeatureFlags(adminToken: string): Promise<{ items: AdminFeatureFlagRecord[] }> {
  return api<{ items: AdminFeatureFlagRecord[] }>("/api/v2/admin/feature-flags", { token: adminToken });
}

export async function setAdminFeatureFlag(
  body: { tenantId: string | null; flag: "planeBOutcomes" | "aiWorkDesign" | "aiProposals"; enabled: boolean; reason: string },
  adminToken: string
): Promise<any> {
  return api("/api/v2/admin/feature-flags", {
    method: "POST",
    body: JSON.stringify(body),
    token: adminToken
  });
}

export async function fetchAdminEntitlements(adminToken: string): Promise<{ items: AdminEntitlementRecord[] }> {
  return api<{ items: AdminEntitlementRecord[] }>("/api/v2/admin/entitlements", { token: adminToken });
}

export async function setAdminEntitlement(
  body: { tenantId: string; featureKey: string; enabled: boolean; notes?: string; reason: string },
  adminToken: string,
  version?: number
): Promise<AdminEntitlementRecord> {
  return api<AdminEntitlementRecord>("/api/v2/admin/entitlements", {
    method: "POST",
    body: JSON.stringify(body),
    token: adminToken,
    ifMatch: version ? String(version) : undefined
  });
}

export async function fetchAdminAiQuota(adminToken: string): Promise<{ items: AdminAiQuotaRecord[] }> {
  return api<{ items: AdminAiQuotaRecord[] }>("/api/v2/admin/ai-quota", { token: adminToken });
}

export async function setAdminTenantAiQuota(
  tenantId: string,
  monthlyBudgetMinor: number,
  reason: string,
  adminToken: string,
  version?: number
): Promise<{ tenantId: string; monthlyBudgetMinor: number; version: number }> {
  return api(`/api/v2/admin/tenants/${encodeURIComponent(tenantId)}/ai-quota`, {
    method: "PUT",
    body: JSON.stringify({ monthlyBudgetMinor, reason }),
    token: adminToken,
    ifMatch: version ? String(version) : undefined
  });
}

export async function requestAdminKillSwitch(
  body: { scope: string; active: boolean; reason: string; expiresAt?: string | null },
  adminToken: string
): Promise<{ status: string; approvalRequest: AdminApprovalRequestRecord }> {
  return api("/api/v2/admin/kill-switches", {
    method: "POST",
    body: JSON.stringify(body),
    token: adminToken
  });
}

export async function fetchAdminOperations(adminToken: string): Promise<AdminOperationsOverview> {
  return api<AdminOperationsOverview>("/api/v2/admin/operations", { token: adminToken });
}

export async function fetchAdminAudit(
  adminToken: string,
  filters?: { q?: string; operator?: string; action?: string; targetType?: string; limit?: number }
): Promise<{ items: AdminPlatformAuditEvent[] }> {
  const qs = new URLSearchParams();
  if (filters?.q) qs.set("q", filters.q);
  if (filters?.operator) qs.set("operator", filters.operator);
  if (filters?.action) qs.set("action", filters.action);
  if (filters?.targetType) qs.set("targetType", filters.targetType);
  if (filters?.limit) qs.set("limit", String(filters.limit));
  const query = qs.toString();
  return api<{ items: AdminPlatformAuditEvent[] }>(query ? `/api/v2/admin/audit?${query}` : "/api/v2/admin/audit", { token: adminToken });
}

export async function exportAdminAudit(
  body: { format: "json" | "csv"; reason: string; operator?: string; action?: string; targetType?: string },
  adminToken: string
): Promise<any> {
  return api("/api/v2/admin/audit/export", {
    method: "POST",
    body: JSON.stringify(body),
    token: adminToken
  });
}

// ==========================================
// Tenant Admin API (/api/v2/tenant-admin/*)
// ==========================================

export interface TenantAdminMembershipItem {
  membershipId: string;
  organizationId: string;
  domainRole: string;
  validFrom: string;
  validTo: string | null;
  version: number;
  activeNow: boolean;
}

export interface TenantAdminUserRecord {
  principalId: string;
  externalSubject: string;
  kind: "USER" | "WORKLOAD";
  active: boolean;
  deactivatedAt: string | null;
  version: number;
  hasApprovalAuthorityNow: boolean;
  activeApproverRoles: string[];
  memberships: TenantAdminMembershipItem[];
}

export interface TenantInvitationRecord {
  id: string;
  organizationId: string;
  maskedEmail: string;
  externalSubject: string | null;
  domainRole: string;
  validFrom: string;
  validTo: string | null;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  invitedBy: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  version: number;
}

export interface TenantUsageOverview {
  tenantId: string;
  aiQuota: {
    window: string;
    windowStart: string;
    resetAt: string;
    allAiDisabled: boolean;
    configuredBudgetCapMinor: number | null;
    totalBudgetMinor: number;
    totalSpentMinor: number;
    totalRemainingMinor: number;
    useCases: Array<{
      useCaseKey: string;
      modelRef: string;
      monthlyBudgetMinor: number;
      spentMinor: number;
      remainingMinor: number;
      killSwitchActive: boolean;
    }>;
  };
  entitlements: unknown;
  platformEntitlements: Array<{ featureKey: string; enabled: boolean; notes: string | null; updatedAt: string; version: number }>;
  connections: Array<{ id: string; source: string; state: string; health: string; lastSuccessAt: string | null; expectedCadenceSeconds: number; version: number }>;
}

export async function fetchTenantAdminUsers(token: string): Promise<{ tenantId: string; items: TenantAdminUserRecord[] }> {
  return api("/api/v2/tenant-admin/users", { token });
}

export async function assignTenantAdminMembership(
  body: {
    principalId?: string;
    externalSubject?: string;
    kind?: "USER" | "WORKLOAD";
    organizationId: string;
    domainRole: string;
    validFrom?: string;
    validTo?: string | null;
    reason: string;
  },
  idempotencyKey: string,
  token: string
): Promise<any> {
  return api("/api/v2/tenant-admin/memberships", {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey,
    token
  });
}

export async function endTenantAdminMembership(
  membershipId: string,
  body: { validTo?: string; reason: string },
  idempotencyKey: string,
  token: string,
  version?: number
): Promise<any> {
  return api(`/api/v2/tenant-admin/memberships/${encodeURIComponent(membershipId)}/end`, {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey,
    ifMatch: version ? String(version) : undefined,
    token
  });
}

export async function setTenantAdminUserStatus(
  principalId: string,
  action: "deactivate" | "reactivate",
  reason: string,
  idempotencyKey: string,
  token: string,
  version?: number
): Promise<{ principalId: string; active: boolean; version: number }> {
  const url =
    action === "deactivate"
      ? `/api/v2/tenant-admin/users/${encodeURIComponent(principalId)}/deactivate`
      : `/api/v2/tenant-admin/users/${encodeURIComponent(principalId)}/reactivate`;
  return api(url, {
    method: "POST",
    body: JSON.stringify({ reason }),
    idempotencyKey,
    ifMatch: version ? String(version) : undefined,
    token
  });
}

export async function fetchTenantInvitations(token: string): Promise<{ tenantId: string; items: TenantInvitationRecord[] }> {
  return api("/api/v2/tenant-admin/invitations", { token });
}

export async function createTenantInvitation(
  body: {
    email: string;
    externalSubject?: string;
    organizationId: string;
    domainRole: string;
    validFrom?: string;
    validTo?: string | null;
    expiresInDays?: number;
    reason: string;
  },
  idempotencyKey: string,
  token: string
): Promise<TenantInvitationRecord> {
  return api("/api/v2/tenant-admin/invitations", {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey,
    token
  });
}

export async function revokeTenantInvitation(
  invitationId: string,
  reason: string,
  idempotencyKey: string,
  token: string,
  version?: number
): Promise<{ id: string; status: string; version: number }> {
  return api(`/api/v2/tenant-admin/invitations/${encodeURIComponent(invitationId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    idempotencyKey,
    ifMatch: version ? String(version) : undefined,
    token
  });
}

export async function updateTenantOrganization(
  orgId: string,
  body: { name: string; parentId?: string | null; reason: string },
  idempotencyKey: string,
  token: string,
  version?: number
): Promise<{ id: string; name: string; parentId: string | null; version: number }> {
  return api(`/api/v2/tenant-admin/organizations/${encodeURIComponent(orgId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    idempotencyKey,
    ifMatch: version ? String(version) : undefined,
    token
  });
}

export async function fetchTenantAdminAudit(
  token: string,
  filters?: { q?: string; command?: string; resourceType?: string; result?: string; limit?: number }
): Promise<{ tenantId: string; items: AuditEvent[] }> {
  const qs = new URLSearchParams();
  if (filters?.q) qs.set("q", filters.q);
  if (filters?.command) qs.set("command", filters.command);
  if (filters?.resourceType) qs.set("resourceType", filters.resourceType);
  if (filters?.result) qs.set("result", filters.result);
  if (filters?.limit) qs.set("limit", String(filters.limit));
  const query = qs.toString();
  return api(query ? `/api/v2/tenant-admin/audit?${query}` : "/api/v2/tenant-admin/audit", { token });
}

export async function fetchTenantAdminRightsRequests(token: string): Promise<{ tenantId: string; items: any[] }> {
  return api("/api/v2/tenant-admin/rights-requests", { token });
}

export async function fetchTenantAdminUsage(token: string): Promise<TenantUsageOverview> {
  return api("/api/v2/tenant-admin/usage", { token });
}
