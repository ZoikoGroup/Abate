// backend/src/platform/rate-limit.ts
// Completion Plan Section 6 / G-18 / T-15:
// Per-tenant, per-actor, and per-IP rate limiting with stricter tiers on AI, exports, and ingestion.
// Returns HTTP 429 RATE_LIMITED with Retry-After header and requestId.

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { loadConfig } from "./config";

export type RateLimitTier = "default" | "ai" | "export" | "ingest";

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  tenantDefaultPerMin: number;
  actorDefaultPerMin: number;
  ipDefaultPerMin: number;
  tierLimits: Record<"ai" | "export" | "ingest", number>;
}

interface WindowBucket {
  start: number;
  count: number;
}

const buckets = new Map<string, WindowBucket>();
let runtimeOverride: Partial<RateLimitConfig> | null = null;

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, b] of buckets) {
    if (b.start < cutoff) buckets.delete(k);
  }
}, 60_000).unref();

export function setRateLimitOverridesForTest(override: Partial<RateLimitConfig> | null): void {
  runtimeOverride = override;
  buckets.clear();
}

export function resetRateLimitBuckets(): void {
  buckets.clear();
}

export function resolveRateLimitConfig(): RateLimitConfig {
  const cfg = loadConfig();
  const isDev = cfg.appEnv === "local" || cfg.appEnv === "test";
  const envDefault = Number(process.env.RATE_LIMIT_PER_MIN || 0);
  const enabled = runtimeOverride?.enabled ?? (envDefault > 0 || !isDev);

  const baseIp = runtimeOverride?.ipDefaultPerMin ?? (envDefault || (isDev ? 0 : 600));
  const tenantDefaultPerMin = runtimeOverride?.tenantDefaultPerMin ?? (Number(process.env.RATE_LIMIT_TENANT_PER_MIN) || (isDev ? baseIp : 300));
  const actorDefaultPerMin = runtimeOverride?.actorDefaultPerMin ?? (Number(process.env.RATE_LIMIT_ACTOR_PER_MIN) || (isDev ? baseIp : 120));

  return {
    enabled,
    windowMs: runtimeOverride?.windowMs ?? 60_000,
    tenantDefaultPerMin,
    actorDefaultPerMin,
    ipDefaultPerMin: baseIp,
    tierLimits: {
      ai: runtimeOverride?.tierLimits?.ai ?? (Number(process.env.RATE_LIMIT_AI_PER_MIN) || 30),
      export: runtimeOverride?.tierLimits?.export ?? (Number(process.env.RATE_LIMIT_EXPORT_PER_MIN) || 20),
      ingest: runtimeOverride?.tierLimits?.ingest ?? (Number(process.env.RATE_LIMIT_INGEST_PER_MIN) || 60)
    }
  };
}

export function classifyRateLimitTier(path: string): RateLimitTier {
  if (path.startsWith("/api/v2/ai/")) return "ai";
  if (path.includes("/export.csv") || path.startsWith("/api/v2/evidence-packages") || path.endsWith("/evidence-package")) return "export";
  if (path.startsWith("/api/v2/connectors/")) return "ingest";
  return "default";
}

function extractActorHints(req: Request): { tenantId?: string; actorSubject?: string } {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const decoded = jwt.decode(auth.slice(7)) as Record<string, unknown> | null;
    if (decoded && typeof decoded === "object") {
      const tenantId = typeof decoded.tenant_id === "string" ? decoded.tenant_id : undefined;
      const actorSubject = typeof decoded.sub === "string" ? decoded.sub : undefined;
      return { tenantId, actorSubject };
    }
  }
  return {};
}

function consumeBucket(key: string, limit: number, windowMs: number, now: number): { allowed: boolean; retryAfterSec: number } {
  if (limit <= 0) return { allowed: true, retryAfterSec: 0 };
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((b.start + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rl = resolveRateLimitConfig();
  if (!rl.enabled) return next();

  const now = Date.now();
  const tier = classifyRateLimitTier(req.path);
  const { tenantId, actorSubject } = extractActorHints(req);

  const checks: Array<{ key: string; limit: number }> = [];

  if (tenantId) {
    const tenantLimit = tier === "default" ? rl.tenantDefaultPerMin : Math.min(rl.tenantDefaultPerMin, rl.tierLimits[tier]);
    checks.push({ key: `tenant:${tenantId}:${tier}`, limit: tenantLimit });
  }
  if (actorSubject) {
    const actorLimit = tier === "default" ? rl.actorDefaultPerMin : Math.min(rl.actorDefaultPerMin, rl.tierLimits[tier]);
    checks.push({ key: `actor:${tenantId || "anon"}:${actorSubject}:${tier}`, limit: actorLimit });
  }
  if (!tenantId && !actorSubject && rl.ipDefaultPerMin > 0) {
    checks.push({ key: `ip:${req.ip || "unknown"}:${tier}`, limit: rl.ipDefaultPerMin });
  }

  for (const c of checks) {
    const resCheck = consumeBucket(c.key, c.limit, rl.windowMs, now);
    if (!resCheck.allowed) {
      res.setHeader("Retry-After", String(resCheck.retryAfterSec));
      res.status(429).json({
        code: "RATE_LIMITED",
        message: "Too many requests. Slow down and retry.",
        requestId: res.locals?.requestId
      });
      return;
    }
  }

  next();
}
