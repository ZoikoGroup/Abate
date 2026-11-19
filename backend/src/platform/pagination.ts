// backend/src/platform/pagination.ts
// Completion Plan Section 6: Cursor pagination and strict allow-listed query filters.
import type { Request, Response } from "express";
import { AppError } from "./errors";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    throw new AppError("VALIDATION", "Invalid pagination cursor.");
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (!decoded) {
      throw new Error("empty");
    }
    return decoded;
  } catch {
    throw new AppError("VALIDATION", "Invalid pagination cursor.");
  }
}

/**
 * Strictly validates query parameters against an allow-list.
 * Rejects unknown query keys with 400 VALIDATION and field name only (never echoes submitted values).
 */
export function validateAllowedQueryParams(req: Request, allowedKeys: string[]): void {
  const allowed = new Set(allowedKeys);
  const unknown: string[] = [];
  for (const key of Object.keys(req.query || {})) {
    if (!allowed.has(key)) {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    throw new AppError("VALIDATION", "Unsupported query filter parameter(s).", undefined, undefined, unknown);
  }
}

/**
 * Applies deterministic keyset cursor pagination over an already-ordered array.
 * Keeps response bodies backward-compatible (array) while setting X-Next-Cursor and X-Has-More headers.
 */
export function applyCursorPagination<T>(
  rows: T[],
  opts: {
    cursor?: string;
    limit: number;
    getKey: (item: T) => string;
  }
): CursorPage<T> {
  let startIdx = 0;
  if (opts.cursor) {
    const targetKey = decodeCursor(opts.cursor);
    const idx = rows.findIndex((r) => opts.getKey(r) === targetKey);
    if (idx >= 0) {
      startIdx = idx + 1;
    } else {
      // Cursor not found (deleted or out of window): return empty page rather than duplicating items
      return { items: [], nextCursor: null, hasMore: false };
    }
  }

  const slice = rows.slice(startIdx, startIdx + opts.limit + 1);
  const hasMore = slice.length > opts.limit;
  const items = hasMore ? slice.slice(0, opts.limit) : slice;
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  const nextCursor = hasMore && last ? encodeCursor(opts.getKey(last)) : null;

  return { items, nextCursor, hasMore };
}

export function setPaginationHeaders(res: Response, page: CursorPage<unknown>): void {
  res.setHeader("X-Has-More", page.hasMore ? "true" : "false");
  if (page.nextCursor) {
    res.setHeader("X-Next-Cursor", page.nextCursor);
  }
}
