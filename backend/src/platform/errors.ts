
// backend/src/platform/errors.ts
import { Response } from "express";
import crypto from "node:crypto";
import { ZodError } from "zod";
import { logSafeError } from "./telemetry";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly requestId: string;
  public readonly retryAfterSeconds?: number;
  public readonly fields: string[];

  constructor(
    code: ErrorCode,
    message?: string,
    requestId?: string,
    retryAfterSeconds?: number,
    fields: string[] = []
  ) {
    const defaultMessages: Record<ErrorCode, string> = {
      UNAUTHENTICATED: "Authentication required.",
      FORBIDDEN: "You do not have access to this.",
      NOT_FOUND: "Not found.",
      CONFLICT: "This changed or key conflict detected. Reload and try again.",
      VALIDATION: "The request was not valid.",
      RATE_LIMITED: "Rate limit or monthly quota exceeded. Continue with the manual workflow or retry later.",
      UNAVAILABLE: "Service temporarily unavailable."
    };

    super(message || defaultMessages[code]);
    this.name = "AppError";
    this.code = code;
    this.requestId = requestId || crypto.randomUUID();
    this.retryAfterSeconds = retryAfterSeconds;
    this.fields = fields;

    const statusCodes: Record<ErrorCode, number> = {
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      VALIDATION: 400,
      RATE_LIMITED: 429,
      UNAVAILABLE: 503
    };
    this.statusCode = statusCodes[code];
  }
}

function extractSafeZodFields(issues: Array<{ path?: (string | number)[]; keys?: unknown[] }> | undefined): string[] {
  const fieldSet = new Set<string>();
  for (const issue of issues ?? []) {
    if (Array.isArray(issue.keys)) {
      for (const k of issue.keys) fieldSet.add(String(k));
    }
    const pathStr = Array.isArray(issue.path) ? issue.path.join(".") : "";
    if (pathStr) {
      fieldSet.add(pathStr);
    } else if (!Array.isArray(issue.keys)) {
      fieldSet.add("body");
    }
  }
  return Array.from(fieldSet);
}

export function toErrorResponse(error: unknown, res: Response) {
  // One id per request (set by telemetryMiddleware) so support can correlate a reported error
  const locals = res.locals ?? {};
  const requestId: string = locals.requestId ?? (error instanceof AppError ? error.requestId : crypto.randomUUID());

  if (error instanceof AppError) {
    locals.errorCode = error.code;
    if (error.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterSeconds))));
    }
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      fields: error.fields,
      requestId
    });
  }

  // Map Zod schema validation errors to unified 400 shape (code, message, fields without values, requestId)
  if (error instanceof ZodError || (error && (error as any).name === "ZodError")) {
    locals.errorCode = "VALIDATION";
    const issues = (error as any).issues as Array<{ path?: (string | number)[]; keys?: unknown[] }> | undefined;
    const fields = extractSafeZodFields(issues);
    return res.status(400).json({
      code: "VALIDATION",
      message: fields.length > 0
        ? `The request failed validation on field(s): ${fields.join(", ")}.`
        : "The request was not valid.",
      fields,
      requestId
    });
  }

  // Safe fallback: log a fingerprint, never the message or stack (driver errors embed row values)
  const entry = logSafeError(requestId, error);
  locals.errorCode = "UNAVAILABLE";
  locals.errorFingerprint = entry.fingerprint;
  return res.status(500).json({
    code: "UNAVAILABLE",
    message: "An internal error occurred. Please contact support.",
    fields: [],
    requestId
  });
}


