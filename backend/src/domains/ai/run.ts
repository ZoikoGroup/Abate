// backend/src/domains/ai/run.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import { ContextRef, AiRunView } from "../../contracts/ai";
import { UseCaseConfig, callModel } from "./gateway";
import { retrieveContext } from "./retrieve";
import { buildPrompt } from "./prompt";
import { validateOutput } from "./validate";
import { assertNoKillSwitch } from "./kill-switch";

export const DEFAULT_AI_USE_CASES: Record<string, UseCaseConfig> = {
  "explain_release": {
    key: "explain_release",
    version: 1,
    purpose: "Explain released cohort psychosocial hazard indicators and suggest organizational mitigations.",
    allowedInputs: ["RELEASE", "KNOWLEDGE"],
    outputSchemaRef: "schema:ai_proposal_v1",
    promptVersion: "explain_release_v1",
    modelRef: "zoiko-mock-v1",
    providerName: "zoiko-mock",
    providerRegion: "eu-west-2",
    maxSteps: 1,
    maxInputTokens: 2048,
    maxOutputTokens: 1024,
    timeoutMs: 8000,
    monthlyBudgetMinor: 100000,
    enabled: true,
    evalThresholds: { usefulness: 0.9, groundedness: 1.0, numericFidelity: 1.0, safety: 1.0 }
  },
  "draft_cause": {
    key: "draft_cause",
    version: 1,
    purpose: "Propose organizational cause hypotheses from verified cohort hazard conditions.",
    allowedInputs: ["RELEASE", "KNOWLEDGE"],
    outputSchemaRef: "schema:ai_proposal_v1",
    promptVersion: "draft_cause_v1",
    modelRef: "zoiko-mock-v1",
    providerName: "zoiko-mock",
    providerRegion: "eu-west-2",
    maxSteps: 1,
    maxInputTokens: 2048,
    maxOutputTokens: 1024,
    timeoutMs: 8000,
    monthlyBudgetMinor: 100000,
    enabled: true,
    evalThresholds: { usefulness: 0.9, groundedness: 1.0, numericFidelity: 1.0, safety: 1.0 }
  },
  "draft_control": {
    key: "draft_control",
    version: 1,
    purpose: "Draft control parameters and suggested verification criteria from the approved catalog.",
    allowedInputs: ["RELEASE", "KNOWLEDGE"],
    outputSchemaRef: "schema:ai_proposal_v1",
    promptVersion: "draft_control_v1",
    modelRef: "zoiko-mock-v1",
    providerName: "zoiko-mock",
    providerRegion: "eu-west-2",
    maxSteps: 1,
    maxInputTokens: 2048,
    maxOutputTokens: 1024,
    timeoutMs: 8000,
    monthlyBudgetMinor: 100000,
    enabled: true,
    evalThresholds: { usefulness: 0.9, groundedness: 1.0, numericFidelity: 1.0, safety: 1.0 }
  }
};

export async function loadUseCase(tx: Tx, key: string): Promise<UseCaseConfig> {
  const res = await tx.q(
    "SELECT * FROM ai_use_case WHERE key = $1 AND enabled = true ORDER BY version DESC LIMIT 1",
    [key]
  );
  if (res.rowCount && res.rowCount > 0) {
    const row = res.rows[0];
    return {
      key: row.key,
      version: row.version,
      purpose: row.purpose,
      allowedInputs: typeof row.allowed_inputs === "string" ? JSON.parse(row.allowed_inputs) : row.allowed_inputs,
      outputSchemaRef: row.output_schema_ref,
      promptVersion: row.prompt_version,
      modelRef: row.model_ref,
      providerName: row.provider_name || (DEFAULT_AI_USE_CASES[row.key]?.providerName) || "zoiko-mock",
      providerRegion: row.provider_region,
      maxSteps: row.max_steps,
      maxInputTokens: row.max_input_tokens,
      maxOutputTokens: row.max_output_tokens,
      timeoutMs: row.timeout_ms,
      monthlyBudgetMinor: Number(row.monthly_budget_minor),
      enabled: row.enabled,
      evalThresholds: typeof row.eval_thresholds === "string" ? JSON.parse(row.eval_thresholds) : row.eval_thresholds
    };
  }

  // Fallback to default in-memory registry
  const def = DEFAULT_AI_USE_CASES[key];
  if (!def || !def.enabled) {
    throw new AppError("UNAVAILABLE", `AI use case ${key} is not enabled or does not exist.`);
  }
  return def;
}

export function assertNotProhibitedRequest(question?: string): void {
  if (!question) return;
  const lower = question.toLowerCase();
  const prohibitedTriggers = [
    "who is most at risk",
    "which employee",
    "rank workers",
    "rank employees",
    "reveal names",
    "list employees",
    "individual performance",
    "who worked the least",
    "who is lazy"
  ];
  for (const trig of prohibitedTriggers) {
    if (lower.includes(trig)) {
      throw new AppError(
        "VALIDATION",
        "Requests to infer, rank, or evaluate individuals are strictly prohibited under the Zoiko Abate Governance Standard."
      );
    }
  }
}

export async function runAiUseCase(
  tx: Tx,
  actor: Actor,
  key: string,
  input: { contextRefs: ContextRef[]; question?: string }
): Promise<AiRunView> {
  // 1. Resolve approved use case from registry
  const uc = await loadUseCase(tx, key);

  // 2. Check kill switches (use_case, model, provider, all_ai)
  await assertNoKillSwitch(tx, [
    `use_case:${key}`,
    `model:${uc.modelRef}`,
    `provider:${uc.providerName}`
  ]);

  // 3. Apply prohibited-use policy to the request before calling any model
  assertNotProhibitedRequest(input.question);

  // 4. Retrieve only authorized released evidence and approved knowledge
  const items = await retrieveContext(actor, input.contextRefs);

  // 5. Call model through provider gateway abstraction
  const prompt = buildPrompt(uc, items, input.question || "");
  const raw = await callModel(uc, prompt);

  let parsedRaw: unknown = null;
  try {
    parsedRaw = JSON.parse(raw.text);
  } catch {
    parsedRaw = { text: raw.text };
  }

  // 6. Validate the output with the 6 output validators
  const validation = validateOutput(parsedRaw, uc, items);
  const status = validation.ok ? "PROPOSED" : "REJECTED_BY_VALIDATOR";

  // 7. Persist context references, validated output, versions, and decision in ai_run
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();

  await tx.q(
    `INSERT INTO ai_run (
      id, tenant_id, use_case_key, use_case_version, actor_id, context_refs,
      output, status, validator_report, model_ref, prompt_version,
      tokens_in, tokens_out, cost_minor, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      runId,
      tx.tenantId,
      uc.key,
      uc.version,
      actor.principalId,
      JSON.stringify(input.contextRefs),
      validation.ok ? JSON.stringify(validation.value) : null,
      status,
      JSON.stringify(validation.report),
      uc.modelRef,
      uc.promptVersion,
      raw.usage.tokensIn,
      raw.usage.tokensOut,
      raw.usage.costMinor,
      now
    ]
  );

  return {
    id: runId,
    tenantId: tx.tenantId,
    useCaseKey: uc.key,
    useCaseVersion: uc.version,
    actorId: actor.principalId,
    contextRefs: input.contextRefs,
    output: validation.ok ? validation.value : null,
    status,
    validatorReport: validation.report,
    modelRef: uc.modelRef,
    promptVersion: uc.promptVersion,
    tokensIn: raw.usage.tokensIn,
    tokensOut: raw.usage.tokensOut,
    costMinor: raw.usage.costMinor,
    createdAt: now
  };
}
