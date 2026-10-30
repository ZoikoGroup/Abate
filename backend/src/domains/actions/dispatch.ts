// backend/src/domains/actions/dispatch.ts
import crypto from "node:crypto";
import { Tx, withTenant } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { ActionAttemptView, ActionAttemptState, ActionProposalInput, ActionDispatchInput } from "../../contracts/actions";
import { assertNoKillSwitch } from "../ai/kill-switch";
import { mintGrant, verifyGrant, paramHashOf } from "./grant";

export interface ToolSender {
  send(
    params: Record<string, any>,
    options: { idempotencyKey: string; timeoutMs: number }
  ): Promise<{ messageId: string; status: string }>;
}

export const toolProviders: Record<string, ToolSender> = {
  "ticket_notification": {
    async send(params, options) {
      if (params.simulateTimeout) {
        throw new Error("ETIMEDOUT: Provider connection timeout after dispatch");
      }
      return {
        messageId: `ticket-msg-${crypto.randomUUID().slice(0, 8)}`,
        status: "DELIVERED"
      };
    }
  },
  "calendar_window": {
    async send(params, options) {
      return {
        messageId: `cal-evt-${crypto.randomUUID().slice(0, 8)}`,
        status: "CREATED"
      };
    }
  }
};

const LEASE_MS = 30000;
const PROVIDER_TIMEOUT_MS = 8000;

// External effects are owned by the people accountable for the control
const ACTION_ROLES = ["RISK_OWNER", "CONTROL_OWNER"];

function requireActionRole(actor: Actor, command: string): void {
  authorize(actor, command);
  if (!actor.memberships.some(m => ACTION_ROLES.includes(m.domain_role))) {
    throw new AppError("FORBIDDEN", "Only a Risk Owner or Control Owner may propose or dispatch external actions.");
  }
}

function toView(row: any): ActionAttemptView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tool: row.tool,
    target: row.target,
    paramHash: row.param_hash,
    resourceVersion: row.resource_version,
    approvalRef: row.approval_ref,
    effectKey: row.effect_key,
    state: row.state,
    leaseOwner: row.lease_owner ?? null,
    fencingToken: Number(row.fencing_token),
    providerReceipt: row.provider_receipt,
    createdAt: new Date(row.created_at).toISOString()
  };
}

/**
 * An action may only run under a Phase 4 approval that still binds the control's CURRENT version
 * ("v4 cannot approve v5"). Returns the reason it is not valid, or null.
 */
export async function approvalProblem(tx: Tx, approvalRef: string | null | undefined, now = new Date()): Promise<string | null> {
  if (!approvalRef) return "No approval is attached to this action.";

  const approval = (await tx.q("SELECT * FROM approval WHERE id = $1", [approvalRef])).rows
    .find((a: any) => a.id === approvalRef);
  if (!approval) return "Approval not found.";
  if (approval.revoked_at) return "Approval has been revoked.";
  if (approval.expires_at && new Date(approval.expires_at) <= now) return "Approval has expired.";

  const control = (await tx.q("SELECT * FROM intervention WHERE id = $1", [approval.intervention_id])).rows
    .find((i: any) => i.id === approval.intervention_id);
  if (!control) return "Approved control not found.";
  if (control.version !== approval.approved_version || control.material_hash !== approval.approved_material_hash) {
    return "The control changed after approval; the approval no longer binds it.";
  }
  if (!["APPROVED", "SCHEDULED", "IMPLEMENTING", "IMPLEMENTED", "VERIFYING"].includes(control.state)) {
    return `The approved control is ${control.state}.`;
  }
  return null;
}

export async function createActionAttempt(
  tx: Tx,
  args: {
    tool: string;
    target: string;
    params: Record<string, any>;
    resourceVersion: number;
    approvalRef?: string;
  }
): Promise<ActionAttemptView> {
  const paramHash = paramHashOf(args.params);
  const effectKey = `effect:${tx.tenantId}:${args.tool}:${args.target}:${args.resourceVersion}:${paramHash}`;

  // Same effect proposed again resolves to the existing attempt (stable provider idempotency key)
  const existing = await tx.q(
    "SELECT * FROM action_attempt WHERE tenant_id = $1 AND effect_key = $2",
    [tx.tenantId, effectKey]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return toView(existing.rows[0]);
  }

  const row = {
    id: crypto.randomUUID(),
    tenant_id: tx.tenantId,
    tool: args.tool,
    target: args.target,
    param_hash: paramHash,
    resource_version: args.resourceVersion,
    approval_ref: args.approvalRef ?? null,
    effect_key: effectKey,
    state: "PENDING",
    fencing_token: 0,
    created_at: new Date().toISOString()
  };
  await tx.q(
    `INSERT INTO action_attempt (
      id, tenant_id, tool, target, param_hash, resource_version,
      approval_ref, effect_key, state, fencing_token, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', 0, $9)`,
    [row.id, row.tenant_id, row.tool, row.target, row.param_hash, row.resource_version, row.approval_ref, row.effect_key, row.created_at]
  );
  return toView(row);
}

/**
 * Propose an external action under a valid approval and mint a grant bound to this exact attempt.
 */
export async function proposeAction(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  input: ActionProposalInput;
  runId?: string;
}): Promise<{ attempt: ActionAttemptView; grantToken: string }> {
  requireActionRole(args.actor, "action.propose");
  const input = ActionProposalInput.parse(args.input);

  const attempt = await withTenant(args.who.tenantId, async (tx) => {
    const problem = await approvalProblem(tx, input.approvalRef);
    if (problem) throw new AppError("FORBIDDEN", problem);
    return createActionAttempt(tx, input);
  });

  const grantToken = mintGrant({
    tenantId: args.who.tenantId,
    actor: args.actor.principalId,
    attemptId: attempt.id,
    ...(args.runId ? { runId: args.runId } : {}),
    tool: attempt.tool,
    paramHash: attempt.paramHash,
    target: attempt.target,
    resourceVersion: attempt.resourceVersion,
    approvalRef: input.approvalRef
  });

  return { attempt, grantToken };
}

export interface DispatchResult {
  state: ActionAttemptState;
  fencingToken: number;
  receipt?: any;
  error?: string;
}

async function recordOutcome(tenantId: string, attemptId: string, fencingToken: number, state: ActionAttemptState, receipt: unknown): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const res = await tx.q(
      `UPDATE action_attempt SET state = $1, provider_receipt = $2 WHERE id = $3 AND tenant_id = $4 AND fencing_token = $5`,
      [state, JSON.stringify(receipt), attemptId, tenantId, fencingToken]
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/**
 * Three steps so a database rollback can never erase a real-world effect:
 *  1. claim a lease (PENDING, or an expired lease) with fencing_token + 1, re-check approval and kill switches; commit
 *  2. call the provider OUTSIDE any transaction, with the stable effect_key as its idempotency key
 *  3. record the outcome only if our fencing token is still current
 * A timeout is UNKNOWN_OUTCOME (never retried blindly).
 */
export async function dispatchAttempt(
  tenantId: string,
  attemptId: string,
  params: Record<string, any>,
  opts: { workerId?: string; now?: Date } = {}
): Promise<DispatchResult> {
  const workerId = opts.workerId ?? "worker-1";
  const now = opts.now ?? new Date();

  const claimed = await withTenant(tenantId, async (tx) => {
    const claim = await tx.q(
      `UPDATE action_attempt
       SET state = 'LEASED', lease_owner = $1, lease_expires_at = $2, fencing_token = fencing_token + 1
       WHERE id = $3 AND tenant_id = $4 AND (state = 'PENDING' OR (state = 'LEASED' AND lease_expires_at < $5))
       RETURNING *`,
      [workerId, new Date(now.getTime() + LEASE_MS).toISOString(), attemptId, tenantId, now.toISOString()]
    );
    if (!claim.rowCount) {
      throw new AppError("CONFLICT", "Could not claim action attempt: it is leased by another worker or already finished.");
    }
    const attempt = claim.rows[0];
    const fencingToken = Number(attempt.fencing_token);

    if (paramHashOf(params) !== attempt.param_hash) {
      throw new AppError("FORBIDDEN", "Mutated action parameters detected: parameters do not match the proposed attempt.");
    }

    const problem = await approvalProblem(tx, attempt.approval_ref, now);
    if (problem) {
      await tx.q(
        `UPDATE action_attempt SET state = $1, provider_receipt = $2 WHERE id = $3 AND tenant_id = $4 AND fencing_token = $5`,
        ["BLOCKED", JSON.stringify({ blocked: problem }), attemptId, tenantId, fencingToken]
      );
      return { attempt, fencingToken, blocked: problem };
    }

    // Throwing here rolls the lease back to PENDING: nothing was sent
    await assertNoKillSwitch(tx, [`tool:${attempt.tool}`]);
    return { attempt, fencingToken, blocked: null as string | null };
  });

  if (claimed.blocked) {
    return { state: "BLOCKED", fencingToken: claimed.fencingToken, error: claimed.blocked };
  }

  const sender = toolProviders[claimed.attempt.tool];
  if (!sender) {
    await recordOutcome(tenantId, attemptId, claimed.fencingToken, "FAILED", { error: "TOOL_NOT_INSTALLED" });
    throw new AppError("NOT_FOUND", `Tool provider ${claimed.attempt.tool} is not installed or enabled.`);
  }

  let state: ActionAttemptState;
  let receipt: any;
  let error: string | undefined;
  try {
    receipt = await Promise.race([
      sender.send(params, { idempotencyKey: claimed.attempt.effect_key, timeoutMs: PROVIDER_TIMEOUT_MS }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ETIMEDOUT: provider did not answer in time")), PROVIDER_TIMEOUT_MS).unref())
    ]);
    state = "SUCCEEDED";
  } catch (err: any) {
    error = String(err?.message ?? err);
    state = /ETIMEDOUT|timeout/i.test(error) ? "UNKNOWN_OUTCOME" : "FAILED";
    receipt = { error };
  }

  if (!(await recordOutcome(tenantId, attemptId, claimed.fencingToken, state, receipt))) {
    throw new AppError("CONFLICT", "Fencing token mismatch: a newer worker has taken over this action attempt.");
  }
  return { state, fencingToken: claimed.fencingToken, ...(state === "SUCCEEDED" ? { receipt } : { error }) };
}

/**
 * HTTP-facing dispatch: the grant must be valid for this tenant and this attempt, and tool, target and
 * parameters are taken from the stored attempt, never from the request.
 */
export async function dispatchAction(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  attemptId: string;
  input: ActionDispatchInput;
}): Promise<DispatchResult> {
  requireActionRole(args.actor, "action.dispatch");
  const input = ActionDispatchInput.parse(args.input);
  if (!input.grantToken) {
    throw new AppError("FORBIDDEN", "Action dispatch requires a signed action grant token.");
  }

  const attempt = await withTenant(args.who.tenantId, async (tx) =>
    (await tx.q("SELECT * FROM action_attempt WHERE id = $1", [args.attemptId])).rows.find((a: any) => a.id === args.attemptId)
  );
  if (!attempt) {
    throw new AppError("NOT_FOUND", "Not found.");
  }

  verifyGrant(input.grantToken, {
    tool: attempt.tool,
    target: attempt.target,
    params: input.params,
    resourceVersion: attempt.resource_version,
    tenantId: args.who.tenantId,
    attemptId: attempt.id,
    approvalRef: attempt.approval_ref
  });

  return dispatchAttempt(args.who.tenantId, attempt.id, input.params);
}
