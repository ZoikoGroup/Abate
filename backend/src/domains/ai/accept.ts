// backend/src/domains/ai/accept.ts
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";

export async function acceptAiRun(
  tx: Tx,
  actor: Actor,
  runId: string,
  options?: { hazardId?: string; causeStatement?: string }
): Promise<{
  runId: string;
  status: "ACCEPTED";
  createdResourceId?: string;
  decisionRef: string;
}> {
  const res = await tx.q(
    "SELECT * FROM ai_run WHERE id = $1 AND tenant_id = $2",
    [runId, tx.tenantId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", "AI run not found.");
  }
  const run = res.rows[0];
  if (run.status !== "PROPOSED") {
    throw new AppError("CONFLICT", `Cannot accept AI run with status ${run.status}.`);
  }

  // Update run status to ACCEPTED
  await tx.q("UPDATE ai_run SET status = 'ACCEPTED' WHERE id = $1", [runId]);

  let createdResourceId: string | undefined = undefined;

  // If a hazardId is provided, create a PROPOSED cause in the hazard domain
  if (options && options.hazardId) {
    const rawOutput = typeof run.output === "string" ? JSON.parse(run.output) : run.output;
    const statement = options.causeStatement || (rawOutput?.claims?.[0]?.text) || "AI-drafted organizational risk hypothesis";
    const causeId = crypto.randomUUID();
    const now = new Date().toISOString();

    await tx.q(
      `INSERT INTO cause (id, tenant_id, hazard_id, statement, status, proposed_by, proposed_at)
       VALUES ($1, $2, $3, $4, 'PROPOSED', $5, $6)`,
      [causeId, tx.tenantId, options.hazardId, statement, actor.principalId, now]
    );
    createdResourceId = causeId;
  }

  return {
    runId,
    status: "ACCEPTED",
    createdResourceId,
    decisionRef: `ai-decision:${runId}`
  };
}

export async function discardAiRun(
  tx: Tx,
  actor: Actor,
  runId: string
): Promise<{ runId: string; status: "DISCARDED" }> {
  const res = await tx.q(
    "SELECT * FROM ai_run WHERE id = $1 AND tenant_id = $2",
    [runId, tx.tenantId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", "AI run not found.");
  }
  const run = res.rows[0];
  if (run.status !== "PROPOSED" && run.status !== "REJECTED_BY_VALIDATOR") {
    throw new AppError("CONFLICT", `Cannot discard AI run with status ${run.status}.`);
  }

  await tx.q("UPDATE ai_run SET status = 'DISCARDED' WHERE id = $1", [runId]);

  return {
    runId,
    status: "DISCARDED"
  };
}
