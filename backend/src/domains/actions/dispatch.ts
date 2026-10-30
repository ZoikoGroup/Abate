// backend/src/domains/actions/dispatch.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { canonicalJson, sha256Hex } from "../../platform/canonical";
import { ActionAttemptView, ActionAttemptState } from "../../contracts/actions";
import { assertNoKillSwitch } from "../ai/kill-switch";

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
  const paramHash = sha256Hex(canonicalJson(args.params));
  const effectKey = `effect:${tx.tenantId}:${args.tool}:${args.target}:${args.resourceVersion}:${paramHash}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Check if attempt already exists for this idempotent effect_key
  const existing = await tx.q(
    "SELECT * FROM action_attempt WHERE tenant_id = $1 AND effect_key = $2",
    [tx.tenantId, effectKey]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const row = existing.rows[0];
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
      leaseOwner: row.lease_owner,
      fencingToken: Number(row.fencing_token),
      providerReceipt: row.provider_receipt,
      createdAt: row.created_at
    };
  }

  await tx.q(
    `INSERT INTO action_attempt (
      id, tenant_id, tool, target, param_hash, resource_version,
      approval_ref, effect_key, state, fencing_token, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', 0, $9)`,
    [
      id,
      tx.tenantId,
      args.tool,
      args.target,
      paramHash,
      args.resourceVersion,
      args.approvalRef || null,
      effectKey,
      now
    ]
  );

  return {
    id,
    tenantId: tx.tenantId,
    tool: args.tool,
    target: args.target,
    paramHash,
    resourceVersion: args.resourceVersion,
    approvalRef: args.approvalRef || null,
    effectKey,
    state: "PENDING",
    fencingToken: 0,
    createdAt: now
  };
}

export async function dispatchAttempt(
  tx: Tx,
  attemptId: string,
  params: Record<string, any>,
  workerId = "worker-1"
): Promise<{ state: ActionAttemptState; fencingToken: number; receipt?: any; error?: string }> {
  // 1. Claim atomically with lease and incremented fencing token
  const leaseExpiresAt = new Date(Date.now() + 30000).toISOString();
  const claimRes = await tx.q(
    `UPDATE action_attempt
     SET state = 'LEASED', lease_owner = $1, lease_expires_at = $2, fencing_token = fencing_token + 1
     WHERE id = $3 AND tenant_id = $4 AND state IN ('PENDING', 'LEASED')
     RETURNING *`,
    [workerId, leaseExpiresAt, attemptId, tx.tenantId]
  );

  if (!claimRes.rowCount || claimRes.rowCount === 0) {
    throw new AppError("CONFLICT", "Could not claim action attempt: lease could not be acquired.");
  }
  const attempt = claimRes.rows[0];
  const assignedFencingToken = Number(attempt.fencing_token);

  // 2. Recheck kill switches immediately before dispatch!
  await assertNoKillSwitch(tx, [`tool:${attempt.tool}`, "all_ai"]);

  const sender = toolProviders[attempt.tool];
  if (!sender) {
    throw new AppError("NOT_FOUND", `Tool provider ${attempt.tool} is not installed or enabled.`);
  }

  try {
    // 3. Send with stable provider idempotency key (effect_key)
    const receipt = await sender.send(params, {
      idempotencyKey: attempt.effect_key,
      timeoutMs: 8000
    });

    // 4. Write success ONLY IF fencing token still matches (fencing guard against stale worker)
    const updateRes = await tx.q(
      `UPDATE action_attempt
       SET state = 'SUCCEEDED', provider_receipt = $1
       WHERE id = $2 AND tenant_id = $3 AND fencing_token = $4
       RETURNING *`,
      [JSON.stringify(receipt), attemptId, tx.tenantId, assignedFencingToken]
    );

    if (!updateRes.rowCount || updateRes.rowCount === 0) {
      throw new AppError("CONFLICT", "Fencing token mismatch: a newer worker has taken over this action attempt.");
    }

    return {
      state: "SUCCEEDED",
      fencingToken: assignedFencingToken,
      receipt
    };
  } catch (err: any) {
    // 5. On timeout after possible dispatch: set UNKNOWN_OUTCOME and reconcile before any retry
    const isTimeout = err.message?.includes("ETIMEDOUT") || err.message?.includes("timeout");
    const targetState: ActionAttemptState = isTimeout ? "UNKNOWN_OUTCOME" : "FAILED";

    await tx.q(
      `UPDATE action_attempt
       SET state = $1, provider_receipt = $2
       WHERE id = $3 AND tenant_id = $4 AND fencing_token = $5`,
      [targetState, JSON.stringify({ error: err.message }), attemptId, tx.tenantId, assignedFencingToken]
    );

    return {
      state: targetState,
      fencingToken: assignedFencingToken,
      error: err.message
    };
  }
}

