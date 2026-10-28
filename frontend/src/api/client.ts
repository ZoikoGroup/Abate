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
  connector_id: string;
  name: string;
  state: "ACTIVE" | "PAUSED" | "REVOKED";
  source_contract_id: string;
  cadence_minutes: number;
  staleness_threshold_minutes: number;
  watermark_cursor: string | null;
  watermark_updated_at: string | null;
  health: "FRESH" | "DELAYED" | "STALE" | "NEVER_SYNCED";
  lag_minutes: number | null;
  created_at: string;
}

export interface IngestReceipt {
  id: string;
  tenant_id: string;
  connection_id: string;
  source_contract_id: string;
  batch_id: string;
  record_count: number;
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  conflicted_count: number;
  received_at: string;
  processed_at: string;
}

export interface WorkFact {
  id: string;
  tenant_id: string;
  connection_id: string;
  pseudonym_id: string;
  source_record_id: string;
  revision: number;
  interval_start: string;
  interval_end: string;
  work_tz: string;
  kind: string;
  recorded_at: string;
  created_at: string;
}

export interface ZoikoTimeBatchPayload {
  batchId: string;
  connectionId: string;
  sentAt: string;
  sourceWatermark?: string;
  records: Array<{
    recordId: string;
    revision: number;
    recordedAt: string;
    subjectId: string;
    intervalStart: string;
    intervalEnd: string;
    workTz: string;
    kind: "ACTIVE_WORK" | "BREAK" | "ON_CALL";
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


