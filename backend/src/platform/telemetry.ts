// backend/src/platform/telemetry.ts
import crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { sha256Hex } from "./canonical";

/**
 * Platform telemetry for B8 (SLOs and zero-impersonation support).
 * Records carry route templates, status and timing only: never raw URLs (ids), bodies,
 * tenant ids, subjects or error messages. Support works from these records and from
 * tenant-issued diagnostic receipts, never from ad-hoc database access.
 */

export type RouteClass = "READ" | "WRITE" | "RELEASED_ANALYTICS" | "EXCLUDED";

export interface RequestRecord {
  requestId: string;
  at: string;
  method: string;
  route: string;
  routeClass: RouteClass;
  status: number;
  durationMs: number;
  errorCode: string | null;
  errorFingerprint: string | null;
}

export interface SafeErrorLogEntry {
  level: "error";
  at: string;
  requestId: string;
  errorName: string;
  fingerprint: string;
}

const MAX_REQUEST_RECORDS = 5000;
const MAX_ERROR_LOGS = 1000;

class TelemetryStore {
  private records: RequestRecord[] = [];
  private byId: Map<string, RequestRecord> = new Map();
  public errorLog: SafeErrorLogEntry[] = [];

  record(r: RequestRecord) {
    this.records.push(r);
    this.byId.set(r.requestId, r);
    if (this.records.length > MAX_REQUEST_RECORDS) {
      const dropped = this.records.shift()!;
      this.byId.delete(dropped.requestId);
    }
  }

  logError(e: SafeErrorLogEntry) {
    this.errorLog.push(e);
    if (this.errorLog.length > MAX_ERROR_LOGS) this.errorLog.shift();
  }

  find(requestId: string): RequestRecord | undefined {
    return this.byId.get(requestId);
  }

  snapshot(): RequestRecord[] {
    return [...this.records];
  }

  clear() {
    this.records = [];
    this.byId.clear();
    this.errorLog = [];
  }
}

export const telemetry = new TelemetryStore();

/**
 * Maps a route template to its B8 latency class. Released analytics has its own budget;
 * health, metadata, dev token issuance and the ops plane itself are not product traffic.
 */
export function classifyRoute(method: string, route: string): RouteClass {
  if (route === "UNMATCHED" || method === "OPTIONS") return "EXCLUDED";
  if (route === "/api/health" || route === "/api/info" || route.startsWith("/api/v2/auth/") || route.startsWith("/api/v2/ops/")) {
    return "EXCLUDED";
  }
  if (route.startsWith("/api/v2/releases")) return "RELEASED_ANALYTICS";
  return method === "GET" || method === "HEAD" ? "READ" : "WRITE";
}

export function errorFingerprint(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  return sha256Hex(`${String(e?.name ?? typeof err)}:${String(e?.message ?? err)}`).slice(0, 16);
}

/**
 * Logs an unexpected error without its message or stack (driver errors can embed row values).
 * The fingerprint lets operators group recurrences without seeing content.
 */
export function logSafeError(requestId: string, err: unknown): SafeErrorLogEntry {
  const rawName = (err as { name?: unknown } | null)?.name;
  const entry: SafeErrorLogEntry = {
    level: "error",
    at: new Date().toISOString(),
    requestId,
    errorName: typeof rawName === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(rawName) ? rawName : "Error",
    fingerprint: errorFingerprint(err)
  };
  telemetry.logError(entry);
  console.error(JSON.stringify(entry));
  return entry;
}

export function telemetryMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = crypto.randomUUID();
  const started = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : "UNMATCHED";
    telemetry.record({
      requestId,
      at: new Date().toISOString(),
      method: req.method,
      route,
      routeClass: classifyRoute(req.method, route),
      status: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      errorCode: res.locals.errorCode ?? null,
      errorFingerprint: res.locals.errorFingerprint ?? null
    });
  });

  next();
}
