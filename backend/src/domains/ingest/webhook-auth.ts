// backend/src/domains/ingest/webhook-auth.ts
// Completion Plan Section 6 / G-19 / T-16:
// Connector webhook authenticity (HMAC-SHA256 signature), timestamp window check, and replay protection.

import crypto from "node:crypto";
import { AppError } from "../../platform/errors";
import { canonicalJson } from "../../platform/canonical";

export const WEBHOOK_MAX_SKEW_SECONDS = 300;
const MAX_REPLAY_ENTRIES = 10_000;

const replayCache = new Map<string, number>();

export function clearWebhookReplayCache(): void {
  replayCache.clear();
}

export function signConnectorWebhook(args: {
  secret: string;
  timestampSec: number;
  nonce: string;
  body: unknown;
}): string {
  const payload = typeof args.body === "string" ? args.body : canonicalJson(args.body);
  const signingInput = `${args.timestampSec}.${args.nonce}.${payload}`;
  const mac = crypto.createHmac("sha256", args.secret).update(signingInput).digest("hex");
  return `t=${args.timestampSec},n=${args.nonce},v1=${mac}`;
}

export function verifyConnectorWebhookRequest(args: {
  secret: string;
  signatureHeader: string | null | undefined;
  timestampHeader?: string | null;
  nonceHeader?: string | null;
  body: unknown;
  nowMs?: number;
  maxSkewSeconds?: number;
}): void {
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const maxSkew = args.maxSkewSeconds ?? WEBHOOK_MAX_SKEW_SECONDS;

  if (!args.secret) {
    throw new AppError("UNAUTHENTICATED", "Connector webhook secret is not configured.");
  }
  if (!args.signatureHeader) {
    throw new AppError("UNAUTHENTICATED", "Missing connector webhook signature.");
  }

  let timestampSec: number | null = args.timestampHeader ? Number(args.timestampHeader) : null;
  let nonce: string | null = args.nonceHeader || null;
  let sigHex: string | null = null;

  if (args.signatureHeader.includes("v1=")) {
    const parts = Object.fromEntries(
      args.signatureHeader.split(",").map((kv) => {
        const idx = kv.indexOf("=");
        return idx === -1 ? [kv.trim(), ""] : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
      })
    );
    if (parts.t) timestampSec = Number(parts.t);
    if (parts.n) nonce = parts.n;
    if (parts.v1) sigHex = parts.v1;
  } else {
    sigHex = args.signatureHeader.trim();
  }

  if (!timestampSec || !Number.isFinite(timestampSec) || !nonce || !sigHex) {
    throw new AppError("UNAUTHENTICATED", "Malformed connector webhook signature header.");
  }

  if (Math.abs(nowSec - timestampSec) > maxSkew) {
    throw new AppError("FORBIDDEN", "Connector webhook timestamp outside allowed replay window.");
  }

  // Prune expired replay keys
  for (const [k, exp] of replayCache) {
    if (exp < nowSec) replayCache.delete(k);
  }

  const replayKey = `${timestampSec}:${nonce}:${sigHex}`;
  if (replayCache.has(replayKey)) {
    throw new AppError("CONFLICT", "Replayed connector webhook request rejected.");
  }

  const payload = typeof args.body === "string" ? args.body : canonicalJson(args.body);
  const signingInput = `${timestampSec}.${nonce}.${payload}`;
  const expectedHex = crypto.createHmac("sha256", args.secret).update(signingInput).digest("hex");

  const sigBuf = Buffer.from(sigHex, "hex");
  const expBuf = Buffer.from(expectedHex, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new AppError("FORBIDDEN", "Invalid connector webhook signature.");
  }

  replayCache.set(replayKey, nowSec + maxSkew);
  if (replayCache.size > MAX_REPLAY_ENTRIES) {
    const oldest = replayCache.keys().next().value;
    if (oldest !== undefined) replayCache.delete(oldest);
  }
}
