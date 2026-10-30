// backend/src/domains/actions/grant.ts
import crypto from "node:crypto";
import { AppError } from "../../platform/errors";
import { loadConfig } from "../../platform/config";
import { canonicalJson, sha256Hex } from "../../platform/canonical";
import { ActionGrantPayload, ActionGrantPayloadSchema } from "../../contracts/actions";

const cfg = loadConfig();
const GRANT_TTL_SECONDS = 120;

function hmac(data: string): Buffer {
  return crypto.createHmac("sha256", cfg.actionGrantSecret).update(data).digest();
}

function signToken(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${hmac(`${header}.${body}`).toString("base64url")}`;
}

function verifyToken(token: string): ActionGrantPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError("FORBIDDEN", "Malformed action grant token format.");
  }
  const [header, body, signature] = parts as [string, string, string];
  const expected = hmac(`${header}.${body}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new AppError("FORBIDDEN", "Action grant signature verification failed.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new AppError("FORBIDDEN", "Malformed action grant token format.");
  }
  const payload = ActionGrantPayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw new AppError("FORBIDDEN", "Action grant payload is not valid.");
  }
  if (payload.data.exp < Math.floor(Date.now() / 1000)) {
    throw new AppError("FORBIDDEN", "Action grant has expired.");
  }
  return payload.data;
}

export function paramHashOf(params: Record<string, any>): string {
  return sha256Hex(canonicalJson(params));
}

export function mintGrant(a: Omit<ActionGrantPayload, "exp">): string {
  return signToken({ ...a, exp: Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS });
}

/**
 * Verifies signature, expiry and payload shape, then every binding the caller supplies.
 * Parameters are compared by hash, so any mutation after the grant was minted is refused.
 */
export function verifyGrant(
  token: string,
  proposed: {
    tool: string;
    target: string;
    params: Record<string, any>;
    resourceVersion?: number;
    tenantId?: string;
    attemptId?: string;
    approvalRef?: string | null;
  }
): ActionGrantPayload {
  const g = verifyToken(token);

  if (g.paramHash !== paramHashOf(proposed.params)) {
    throw new AppError("FORBIDDEN", "Mutated action parameters detected: parameter hash does not match approved action grant.");
  }
  if (g.target !== proposed.target || g.tool !== proposed.tool) {
    throw new AppError("FORBIDDEN", "Action grant target or tool does not match proposed action execution.");
  }
  const mismatch =
    (proposed.tenantId !== undefined && g.tenantId !== proposed.tenantId) ||
    (proposed.attemptId !== undefined && g.attemptId !== proposed.attemptId) ||
    (proposed.resourceVersion !== undefined && g.resourceVersion !== proposed.resourceVersion) ||
    (proposed.approvalRef !== undefined && g.approvalRef !== proposed.approvalRef);
  if (mismatch) {
    throw new AppError("FORBIDDEN", "Action grant does not authorise this attempt.");
  }
  return g;
}
