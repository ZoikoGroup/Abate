// backend/src/contracts/ai.ts
import { z } from "zod";

export const AiClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(z.string().min(1)).min(1)
}).strict();
export type AiClaim = z.infer<typeof AiClaimSchema>;

export const AiProposalSchema = z.object({
  title: z.string().min(1),
  claims: z.array(AiClaimSchema).min(1),
  uncertainty: z.string().min(1),
  suggestedControls: z.array(z.string().min(1)).optional()
}).strict();
export type AiProposal = z.infer<typeof AiProposalSchema>;

export const AiRunStatusEnum = z.enum([
  "PROPOSED",
  "REJECTED_BY_VALIDATOR",
  "ACCEPTED",
  "DISCARDED",
  "FAILED"
]);
export type AiRunStatus = z.infer<typeof AiRunStatusEnum>;

export const ValidatorFailureCodeEnum = z.enum([
  "SCHEMA",
  "CITATION",
  "NUMERIC_FIDELITY",
  "CONTROL_ELIGIBILITY",
  "PROHIBITED_INFERENCE",
  "REGION_PROVIDER"
]);
export type ValidatorFailureCode = z.infer<typeof ValidatorFailureCodeEnum>;

export const ValidatorReportSchema = z.object({
  ok: z.boolean(),
  failureCode: ValidatorFailureCodeEnum.optional(),
  details: z.string().optional(),
  violations: z.array(z.string()).optional()
}).strict();
export type ValidatorReport = z.infer<typeof ValidatorReportSchema>;

export const ContextRefSchema = z.object({
  type: z.enum(["RELEASE", "KNOWLEDGE"]),
  id: z.string().min(1)
}).strict();
export type ContextRef = z.infer<typeof ContextRefSchema>;

export const AiRunViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  useCaseKey: z.string().min(1),
  useCaseVersion: z.number().int().positive(),
  actorId: z.string().min(1),
  contextRefs: z.array(ContextRefSchema),
  output: AiProposalSchema.nullable().optional(),
  status: AiRunStatusEnum,
  validatorReport: ValidatorReportSchema.optional(),
  modelRef: z.string().min(1),
  promptVersion: z.string().min(1),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costMinor: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime()
}).strict();
export type AiRunView = z.infer<typeof AiRunViewSchema>;

export const ExplainReleaseInput = z.object({
  releaseId: z.string().min(1),
  question: z.string().optional()
}).strict();
export type ExplainReleaseInput = z.infer<typeof ExplainReleaseInput>;

export const DraftCauseInput = z.object({
  hazardId: z.string().min(1)
}).strict();
export type DraftCauseInput = z.infer<typeof DraftCauseInput>;

export const DraftControlInput = z.object({
  hazardId: z.string().min(1),
  causeId: z.string().min(1)
}).strict();
export type DraftControlInput = z.infer<typeof DraftControlInput>;

export const KillSwitchInput = z.object({
  scope: z.string().min(1),
  active: z.boolean()
}).strict();
export type KillSwitchInput = z.infer<typeof KillSwitchInput>;

