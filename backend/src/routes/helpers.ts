// backend/src/routes/helpers.ts
// Shared HTTP request helpers used across mounted Express route modules.
import type { Request } from "express";
import { AppError } from "../platform/errors";
import { checkPgHealth } from "../platform/db/with-tenant";

export function parseLimit(req: Request, def: number, max: number): number {
  const raw = Number(req.query.limit);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, max) : def;
}

export function getHeader(req: Request, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (!val) return null;
  return Array.isArray(val) ? val[0] ?? null : val;
}

export async function checkPgHealthSafe(): Promise<boolean> {
  try {
    return await checkPgHealth();
  } catch {
    return false;
  }
}

export function parseAt(raw: unknown): Date | undefined {
  if (raw === undefined) return undefined;
  const at = new Date(String(raw));
  if (Number.isNaN(at.getTime())) {
    throw new AppError("VALIDATION", "Query parameter 'at' must be an ISO 8601 timestamp.");
  }
  return at;
}
