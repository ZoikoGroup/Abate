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
  | "UNAVAILABLE";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly requestId: string;

  constructor(code: ErrorCode, message?: string, requestId?: string) {
    const defaultMessages: Record<ErrorCode, string> = {
      UNAUTHENTICATED: "Authentication required.",
      FORBIDDEN: "You do not have access to this.",
      NOT_FOUND: "Not found.",
      CONFLICT: "This changed or key conflict detected. Reload and try again.",
      VALIDATION: "The request was not valid.",
      UNAVAILABLE: "Service temporarily unavailable."
    };

    super(message || defaultMessages[code]);
    this.name = "AppError";
    this.code = code;
    this.requestId = requestId || crypto.randomUUID();

    const statusCodes: Record<ErrorCode, number> = {
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      VALIDATION: 400,
      UNAVAILABLE: 503
    };
    this.statusCode = statusCodes[code];
  }
}

export function toErrorResponse(error: unknown, res: Response) {
  // One id per request (set by telemetryMiddleware) so support can correlate a reported error
  const locals = res.locals ?? {};
  const requestId: string = locals.requestId ?? (error instanceof AppError ? error.requestId : crypto.randomUUID());

  if (error instanceof AppError) {
    locals.errorCode = error.code;
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      requestId
    });
  }

  // Map Zod schema validation errors to safe 400 VALIDATION response (Phase 0 / Phase 1 standard)
  if (error instanceof ZodError || (error && (error as any).name === "ZodError")) {
    locals.errorCode = "VALIDATION";
    return res.status(400).json({
      code: "VALIDATION",
      message: "The request was not valid.",
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
    requestId
  });
}


