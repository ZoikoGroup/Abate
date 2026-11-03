// backend/src/contracts/outcomes.ts
// Phase 7: Work-design outcomes contracts (Domain S13 / Package B7)
import { z } from "zod";

export const OutcomeClassEnum = z.enum(["COMPLIANCE_EVIDENCE", "PERFORMANCE_OUTCOME"]);
export type OutcomeClass = z.infer<typeof OutcomeClassEnum>;

export const OutcomeFamilyEnum = z.enum([
  "WORKLOAD_SUSTAINABILITY",
  "ROLE_CLARITY",
  "FRAGMENTATION",
  "HUMAN_AI_WORK_QUALITY"
]);
export type OutcomeFamily = z.infer<typeof OutcomeFamilyEnum>;

export const OutcomeStatusEnum = z.enum(["DRAFT", "APPROVED", "RETIRED"]);
export type OutcomeStatus = z.infer<typeof OutcomeStatusEnum>;

// Outcome Definition
export const CreateOutcomeDefinitionInput = z.object({
  outcomeId: z.string().min(1),
  version: z.number().int().min(1).default(1),
  outcomeClass: OutcomeClassEnum.default("PERFORMANCE_OUTCOME"),
  family: OutcomeFamilyEnum,
  purpose: z.string().min(1),
  prohibitedInterpretation: z.string().min(1),
  unit: z.string().min(1),
  definition: z.record(z.string(), z.any()),
  qualityRules: z.record(z.string(), z.any()),
  privacyClass: z.string().default("B")
}).strict();
export type CreateOutcomeDefinitionInput = z.infer<typeof CreateOutcomeDefinitionInput>;

export interface OutcomeDefinitionView {
  outcomeId: string;
  version: number;
  outcomeClass: OutcomeClass;
  family: OutcomeFamily;
  purpose: string;
  prohibitedInterpretation: string;
  unit: string;
  definition: Record<string, any>;
  qualityRules: Record<string, any>;
  privacyClass: string;
  status: OutcomeStatus;
  definitionHash: string;
}

// Outcome Evaluation (Plane B)
export const EvaluateOutcomeInput = z.object({
  outcomeId: z.string().min(1),
  outcomeVersion: z.number().int().min(1).default(1),
  interventionId: z.string().uuid().optional(),
  comparisonBasis: z.record(z.string(), z.any()).default({}),
  confounders: z.record(z.string(), z.any()).default({}),
  seriesBreak: z.boolean().default(false),
  outcomeConfidence: z.enum(["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_DATA"]).default("MEDIUM"),
  permittedClaims: z.array(z.string()).min(1),
  evidenceRefs: z.array(z.string()).default([]),
  releaseId: z.string().min(1)
}).strict();
export type EvaluateOutcomeInput = z.infer<typeof EvaluateOutcomeInput>;

export interface OutcomeEvaluationView {
  id: string;
  tenantId: string;
  outcomeId: string;
  outcomeVersion: number;
  interventionId?: string;
  comparisonBasis: Record<string, any>;
  confounders: Record<string, any>;
  seriesBreak: boolean;
  outcomeConfidence: string;
  permittedClaims: string[];
  evidenceRefs: string[];
  releaseId: string;
  plane: "B";
  createdAt: string;
}

// Feature Flag
export const ToggleFeatureFlagInput = z.object({
  flag: z.string().min(1),
  enabled: z.boolean(),
  tenantId: z.string().uuid().optional()
}).strict();
export type ToggleFeatureFlagInput = z.infer<typeof ToggleFeatureFlagInput>;

export interface FeatureFlagView {
  flag: string;
  enabled: boolean;
  tenantId: string | null;
  changedBy?: string;
  changedAt?: string;
}
