// backend/src/domains/actions/grant.ts
import crypto from "node:crypto";
import { AppError } from "../../platform/errors";
import { canonicalJson, sha256Hex } from "../../platform/canonical";
import { ActionGrantPayload } from "../../contracts/actions";

const ACTION_SIGNING_SECRET = "abate-action-grant-signing-secret-v1";

function signToken(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", ACTION_SIGNING_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyToken(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError("FORBIDDEN", "Malformed action grant token format.");
  }
  const [header, body, signature] = parts;
  const expectedSig = crypto
    .createHmac("sha256", ACTION_SIGNING_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  if (signature !== expectedSig) {
    throw new AppError("FORBIDDEN", "Action grant signature verification failed.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) {
    throw new AppError("FORBIDDEN", "Action grant has expired.");
  }

  return payload;
}

export function mintGrant(a: {
  tenantId: string;
  actor: string;
  runId: string;
  tool: string;
  paramHash: string;
  target: string;
  resourceVersion: number;
  approvalRef?: string;
}): string {
  const exp = Math.floor(Date.now() / 1000) + 120; // 120 seconds short-lived grant
  return signToken({ ...a, exp });
}

export function verifyGrant(
  token: string,
  proposed: {
    tool: string;
    target: string;
    params: Record<string, any>;
    resourceVersion?: number;
  }
): ActionGrantPayload {
  const g = verifyToken(token) as ActionGrantPayload;

  // 1. Parameter-hash binding: detect any parameter mutation
  const actualHash = sha256Hex(canonicalJson(proposed.params));
  if (g.paramHash !== actualHash) {
    throw new AppError(
      "FORBIDDEN",
      "Mutated action parameters detected: parameter hash does not match approved action grant."
    );
  }

  // 2. Target and Tool binding
  if (g.target !== proposed.target || g.tool !== proposed.tool) {
    throw new AppError(
      "FORBIDDEN",
      "Action grant target or tool does not match proposed action execution."
    );
  }

  return g;
}

