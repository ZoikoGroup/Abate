// backend/src/contracts/control.ts
import { z } from "zod";

// ==========================================
// Phase 4: State Enums & Invariants
// ==========================================

export const ControlStateEnum = z.enum([
  "DRAFT",
  "PROPOSED",
  "REVIEW_REQUIRED",
  "CONSULTATION_REQUIRED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "SCHEDULED",
  "IMPLEMENTING",
  "IMPLEMENTED",
  "VERIFYING",
  "CLOSED",
  "REOPENED",
  "CANCELLED",
  "SUPERSEDED"
]);
export type ControlState = z.infer<typeof ControlStateEnum>;

export const VerificationOutcomeEnum = z.enum([
  "EFFECTIVE",
  "PARTIALLY_EFFECTIVE",
  "NOT_EFFECTIVE",
  "INCONCLUSIVE"
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeEnum>;

export const HazardDispositionEnum = z.enum([
  "OPEN",
  "CONTROLLED",
  "DEFERRED",
  "ACCEPTED",
  "VERIFIED_CLOSURE"
]);
export type HazardDisposition = z.infer<typeof HazardDispositionEnum>;

export const CauseStatusEnum = z.enum([
  "PROPOSED",
  "REVIEWED_ACCEPTED",
  "REVIEWED_REJECTED"
]);
export type CauseStatus = z.infer<typeof CauseStatusEnum>;

// ==========================================
// Zod Request Schemas
// ==========================================

export const CreateHazardInput = z.object({
  title: z.string().min(3),
  originatingReleaseId: z.string().min(1)
}).strict();
export type CreateHazardInput = z.infer<typeof CreateHazardInput>;

export const ProposeCauseInput = z.object({
  statement: z.string().min(5) // Organizational explanation, never about a person
}).strict();
export type ProposeCauseInput = z.infer<typeof ProposeCauseInput>;

export const ReviewCauseInput = z.object({
  status: z.enum(["REVIEWED_ACCEPTED", "REVIEWED_REJECTED"]),
  note: z.string().optional()
}).strict();
export type ReviewCauseInput = z.infer<typeof ReviewCauseInput>;

export const CreateControlInput = z.object({
  hazardId: z.string().min(1),
  causeId: z.string().min(1),
  scope: z.string().min(3),
  objective: z.string().min(3),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verificationPlan: z.record(z.string(), z.any())
}).strict();
export type CreateControlInput = z.infer<typeof CreateControlInput>;

export const UpdateControlInput = z.object({
  scope: z.string().min(3).optional(),
  objective: z.string().min(3).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  verificationPlan: z.record(z.string(), z.any()).optional()
}).strict();
export type UpdateControlInput = z.infer<typeof UpdateControlInput>;

export const ApproveControlInput = z.object({
  note: z.string().optional()
}).strict();
export type ApproveControlInput = z.infer<typeof ApproveControlInput>;

export const ImplementationReceiptInput = z.object({
  kind: z.enum(["MANUAL", "INTEGRATED"]),
  completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  evidenceRefs: z.array(z.string().min(1)).min(1)
}).strict();
export type ImplementationReceiptInput = z.infer<typeof ImplementationReceiptInput>;

export const PinVerificationPlanInput = z.object({
  baselineReleaseId: z.string().min(1),
  postReleaseId: z.string().min(1).optional(),
  adjacentReleaseIds: z.array(z.string().min(1)).default([]),
  direction: z.enum(["DECREASE", "INCREASE"]).default("DECREASE"),
  criteria: z.number().default(20.0), // e.g. target 20% improvement
  adjacentTolerance: z.number().default(5.0), // max allowable increase in adjacent cohort
  seriesBreak: z.boolean().default(false)
}).strict();
export type PinVerificationPlanInput = z.infer<typeof PinVerificationPlanInput>;

export const ConcludeVerificationInput = z.object({
  outcome: VerificationOutcomeEnum,
  residualRisk: z.string().min(5),
  postReleaseId: z.string().min(1)
}).strict();
export type ConcludeVerificationInput = z.infer<typeof ConcludeVerificationInput>;

export const SetDispositionInput = z.object({
  disposition: HazardDispositionEnum,
  rationale: z.string().min(5),
  residualRisk: z.string().min(3),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
}).strict();
export type SetDispositionInput = z.infer<typeof SetDispositionInput>;

// ==========================================
// Server-Computed UI Contract Types
// ==========================================

export interface MaterialChange {
  field: string;
  from: any;
  to: any;
}

export interface ApplicableGate {
  gate: "REVIEW" | "CONSULTATION" | "APPROVAL";
  satisfied: boolean;
}

export interface ControlDetailView {
  id: string;
  tenantId: string;
  hazardId: string;
  causeId: string;
  state: ControlState;
  version: number;
  scope: string;
  objective: string;
  ownerPrincipalId: string;
  dueDate: string;
  verificationPlan: Record<string, any>;
  materialHash: string;
  allowedActions: string[];
  applicableGates: ApplicableGate[];
  materialChanges: MaterialChange[];
  etag: string;
  approval?: {
    approvedVersion: number;
    approvedMaterialHash: string;
    approverPrincipalId: string;
    approvedAt: string;
  } | null;
  receipt?: {
    kind: string;
    completedOn: string;
    evidenceRefs: string[];
    recordedAt: string;
  } | null;
  evaluation?: {
    plan: any;
    outcome: string | null;
    reviewerId: string | null;
    residualRisk: string | null;
    concludedAt: string | null;
  } | null;
}
