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

// Normalise so trivial rewording (case, punctuation, accents, extra spaces, zero-width chars) cannot dodge the screen.
function normaliseQuestion(question: string): string {
  return question
    .normalize("NFKD")
    .replace(/[̀-ͯ​-‏⁠﻿]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PERSON_NOUN = "(?:employee|worker|lawyer|solicitor|associate|partner|paralegal|staff|person|people|individual|member|colleague|trainee|intern|manager|user|banda|bande|log|karmchari)s?";
const PERSON_TARGETING_VERB = "(?:rank|ranking|rate|score|grade|compare|list|name|identify|reveal|expose|show|find|pick|single out|flag|profile|track|monitor|batao|bata|dikhao)";
const SUPERLATIVE = "(?:most|least|more|less|highest|lowest|worst|best|top|bottom|sabse|zyada|jyada|kam)";
const PERSONAL_STATE = "(?:at risk|risk|tired|stressed|burn(?:ed|t)? ?out|overworked|burnt|lazy|unproductive|slow|sick|absent|late|hours|overtime|worked|working|thaka|thak|aalsi|bimar|kaam)";

const PROHIBITED_REQUEST_PATTERNS: RegExp[] = [
  // Original phrase list, kept as plain substrings of the normalised text
  /who is most at risk/,
  /which employee/,
  /rank (workers|employees)/,
  /reveal names/,
  /list employees/,
  /individual performance/,
  /who worked the least/,
  /who is lazy/,
  // "who ... most/least/highest ... at risk/tired/hours"
  new RegExp(`\\bwho\\b.{0,60}\\b${SUPERLATIVE}\\b.{0,40}\\b${PERSONAL_STATE}\\b`),
  new RegExp(`\\bwho\\b.{0,30}\\b${PERSONAL_STATE}\\b.{0,40}\\b${SUPERLATIVE}\\b`),
  // "which/what employee|lawyer|person ..."
  new RegExp(`\\b(?:which|what|whose)\\s+(?:\\w+\\s+){0,2}${PERSON_NOUN}\\b`),
  // "rank/list/name/identify ... employees"
  new RegExp(`\\b${PERSON_TARGETING_VERB}\\b.{0,40}\\b${PERSON_NOUN}\\b`),
  // individual performance / productivity / health style asks
  /\b(?:individual|personal|per person|per employee|per worker)\b.{0,30}\b(?:performance|productivity|score|ranking|hours|health|sickness|absence)\b/,
  // named person + judgement
  /\b(?:is|was)\s+\w+\s+(?:lazy|slacking|underperforming|unproductive)\b/,
  // Hinglish: kaun/kisne/kiska + superlative or state
  new RegExp(`\\b(?:kaun|kon|kisne|kiska|kisko|kiski)\\b.{0,60}\\b${PERSONAL_STATE}\\b`),
  new RegExp(`\\b(?:kaun|kon|kisne|kiska|kisko)\\b.{0,40}\\b${SUPERLATIVE}\\b`),
  /\bnaam\b.{0,20}\b(?:batao|bata|do|list|dikhao)\b/,
  /\b(?:batao|bata|dikhao)\b.{0,20}\bnaam\b/
];

export function isProhibitedRequest(question?: string): boolean {
  if (!question) return false;
  const text = normaliseQuestion(question);
  return PROHIBITED_REQUEST_PATTERNS.some(re => re.test(text));
}

export function assertNotProhibitedRequest(question?: string): void {
  if (isProhibitedRequest(question)) {
    throw new AppError(
      "VALIDATION",
      "Requests to infer, rank, or evaluate individuals are strictly prohibited under the Zoiko Abate Governance Standard."
    );
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
  const items = await retrieveContext(actor, input.contextRefs, tx);

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
