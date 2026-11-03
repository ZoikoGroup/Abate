// backend/src/domains/performance/definitions.ts
// Outcome definitions management (Plane B: Work-Design Outcomes)
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { canonicalJson } from "../../platform/canonical";
import {
  CreateOutcomeDefinitionInput,
  OutcomeDefinitionView,
  OutcomeFamily
} from "../../contracts/outcomes";

export const PROTOTYPE_OUTCOME_DEFINITIONS: Array<{
  outcomeId: string;
  version: number;
  outcomeClass: "PERFORMANCE_OUTCOME";
  family: OutcomeFamily;
  purpose: string;
  prohibitedInterpretation: string;
  unit: string;
  definition: Record<string, any>;
  qualityRules: Record<string, any>;
  privacyClass: string;
}> = [
  {
    outcomeId: "WORKLOAD_SUSTAINABILITY",
    version: 1,
    outcomeClass: "PERFORMANCE_OUTCOME",
    family: "WORKLOAD_SUSTAINABILITY",
    purpose: "Is demand within sustainable limits over time across approved intervals and deadlines?",
    prohibitedInterpretation: "Cohort work condition, NOT an individual capacity score or productivity quota.",
    unit: "ratio",
    definition: {
      formula: "sustainable_interval_hours / total_demand_hours",
      sourceCoverage: ["time_intervals", "matter_deadlines"]
    },
    qualityRules: { minCoverage: 0.8, missing: "INSUFFICIENT_DATA" },
    privacyClass: "B"
  },
  {
    outcomeId: "ROLE_CLARITY",
    version: 1,
    outcomeClass: "PERFORMANCE_OUTCOME",
    family: "ROLE_CLARITY",
    purpose: "Do people have clear decision rights and expectations within the work system?",
    prohibitedInterpretation: "Perception at cohort level; NOT sentiment mining of communications.",
    unit: "score_5pt",
    definition: {
      formula: "cohort_avg(structured_consultation_clarity)",
      sourceCoverage: ["consented_work_condition_surveys"]
    },
    qualityRules: { minResponses: 10, missing: "INSUFFICIENT_DATA" },
    privacyClass: "B"
  },
  {
    outcomeId: "FRAGMENTATION_INDEX",
    version: 1,
    outcomeClass: "PERFORMANCE_OUTCOME",
    family: "FRAGMENTATION",
    purpose: "How split is work across tasks and handoffs?",
    prohibitedInterpretation: "Describes process structure, NOT personal productivity or multi-tasking skill.",
    unit: "handoffs_per_task",
    definition: {
      formula: "total_handoffs / completed_work_items",
      sourceCoverage: ["work_item_handoff_metadata"]
    },
    qualityRules: { minItems: 20, missing: "INSUFFICIENT_DATA" },
    privacyClass: "B"
  },
  {
    outcomeId: "AI_REWORK_RATE",
    version: 1,
    outcomeClass: "PERFORMANCE_OUTCOME",
    family: "HUMAN_AI_WORK_QUALITY",
    purpose: "Cohort-level rate of AI-assisted tasks that required rework or exception handling.",
    prohibitedInterpretation: "Not a measure of any individual's performance, skill or employability. Never copied prompt or response content.",
    unit: "percent",
    definition: {
      numerator: "count(ai_assisted_tasks WHERE rework_flag = true)",
      denominator: "count(ai_assisted_tasks)",
      allowedDimensions: ["team", "practiceArea"],
      releaseClass: "B"
    },
    qualityRules: { minCoverage: "per definition owner", missing: "INSUFFICIENT_DATA" },
    privacyClass: "B"
  }
];

/**
 * calculateDefinitionHash: Cryptographic SHA-256 of canonical definition JSON.
 */
export function calculateDefinitionHash(def: Record<string, any>): string {
  return crypto.createHash("sha256").update(canonicalJson(def)).digest("hex");
}

/**
 * createOutcomeDefinition: Creates a new outcome definition in DRAFT status.
 */
export async function createOutcomeDefinition(
  tx: Tx,
  input: CreateOutcomeDefinitionInput
): Promise<OutcomeDefinitionView> {
  const hash = calculateDefinitionHash(input.definition);
  const status = "DRAFT";

  await tx.q(
    `INSERT INTO outcome_definition (
      outcome_id, version, outcome_class, family, purpose,
      prohibited_interpretation, unit, definition, quality_rules,
      privacy_class, status, definition_hash
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.outcomeId,
      input.version,
      input.outcomeClass,
      input.family,
      input.purpose,
      input.prohibitedInterpretation,
      input.unit,
      input.definition,
      input.qualityRules,
      input.privacyClass,
      status,
      hash
    ]
  );

  return {
    outcomeId: input.outcomeId,
    version: input.version,
    outcomeClass: input.outcomeClass,
    family: input.family,
    purpose: input.purpose,
    prohibitedInterpretation: input.prohibitedInterpretation,
    unit: input.unit,
    definition: input.definition,
    qualityRules: input.qualityRules,
    privacyClass: input.privacyClass,
    status,
    definitionHash: hash
  };
}

/**
 * approveOutcomeDefinition: Marks a definition as APPROVED.
 * After approval, outcome_class is immutable.
 */
export async function approveOutcomeDefinition(
  tx: Tx,
  outcomeId: string,
  version = 1
): Promise<OutcomeDefinitionView> {
  const res = await tx.q(
    `SELECT * FROM outcome_definition WHERE outcome_id = $1 AND version = $2`,
    [outcomeId, version]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", `Outcome definition '${outcomeId}' v${version} not found.`);
  }

  await tx.q(
    `UPDATE outcome_definition SET status = 'APPROVED' WHERE outcome_id = $1 AND version = $2`,
    [outcomeId, version]
  );

  const row = res.rows[0];
  return {
    outcomeId: row.outcome_id,
    version: row.version,
    outcomeClass: row.outcome_class,
    family: row.family,
    purpose: row.purpose,
    prohibitedInterpretation: row.prohibited_interpretation,
    unit: row.unit,
    definition: row.definition,
    qualityRules: row.quality_rules,
    privacyClass: row.privacy_class,
    status: "APPROVED",
    definitionHash: row.definition_hash
  };
}

/**
 * getOutcomeDefinition: Fetches outcome definition by id and version.
 */
export async function getOutcomeDefinition(
  tx: Tx,
  outcomeId: string,
  version = 1
): Promise<OutcomeDefinitionView> {
  const res = await tx.q(
    `SELECT * FROM outcome_definition WHERE outcome_id = $1 AND version = $2`,
    [outcomeId, version]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", `Outcome definition '${outcomeId}' v${version} not found.`);
  }
  const row = res.rows[0];
  return {
    outcomeId: row.outcome_id,
    version: row.version,
    outcomeClass: row.outcome_class,
    family: row.family,
    purpose: row.purpose,
    prohibitedInterpretation: row.prohibited_interpretation,
    unit: row.unit,
    definition: row.definition,
    qualityRules: row.quality_rules,
    privacyClass: row.privacy_class,
    status: row.status,
    definitionHash: row.definition_hash
  };
}

/**
 * listOutcomeDefinitions: Lists all outcome definitions.
 */
export async function listOutcomeDefinitions(
  tx: Tx
): Promise<OutcomeDefinitionView[]> {
  const res = await tx.q(
    `SELECT * FROM outcome_definition ORDER BY outcome_id ASC, version DESC`
  );
  return res.rows.map((row: any) => ({
    outcomeId: row.outcome_id,
    version: row.version,
    outcomeClass: row.outcome_class,
    family: row.family,
    purpose: row.purpose,
    prohibitedInterpretation: row.prohibited_interpretation,
    unit: row.unit,
    definition: row.definition,
    qualityRules: row.quality_rules,
    privacyClass: row.privacy_class,
    status: row.status,
    definitionHash: row.definition_hash
  }));
}
