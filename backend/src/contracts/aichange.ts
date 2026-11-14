
// backend/src/contracts/aichange.ts
// Phase 7: AI Work-Design Risk assessment contracts (Domain S14 / Package B7)
import { z } from "zod";

export const AutomationModeEnum = z.enum(["ASSIST", "AUTOMATE_WITH_REVIEW", "AUTONOMOUS_BOUNDED"]);
export type AutomationMode = z.infer<typeof AutomationModeEnum>;

export const AiChangeStageEnum = z.enum([
  "REGISTERED",
  "BASELINE",
  "DETECT",
  "ATTRIBUTE",
  "CONTROL",
  "VERIFY",
  "PERFORMANCE_REVIEW",
  "CLOSED"
]);
export type AiChangeStage = z.infer<typeof AiChangeStageEnum>;

export const CreateAiChangeProfileInput = z.object({
  title: z.string().min(1),
  affectedRoles: z.array(z.string()).min(1),
  affectedTasks: z.array(z.string()).min(1),
  automationMode: AutomationModeEnum.default("ASSIST"),
  decisionRights: z.string().min(1),
  humanOverride: z.string().min(1),
  monitoringChanges: z.string().min(1),
  throughputAssumptions: z.string().min(1),
  rolloutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trainingSupport: z.string().min(1)
}).strict();
export type CreateAiChangeProfileInput = z.infer<typeof CreateAiChangeProfileInput>;

export interface AiChangeProfileView {
  id: string;
  tenantId: string;
  title: string;
  version: number;
  affectedRoles: string[];
  affectedTasks: string[];
  automationMode: AutomationMode;
  decisionRights: string;
  humanOverride: string;
  monitoringChanges: string;
  throughputAssumptions: string;
  rolloutDate: string;
  trainingSupport: string;
}

export const CreateAssessmentInput = z.object({
  profileId: z.string().uuid(),
  profileVersion: z.number().int().min(1).default(1)
}).strict();
export type CreateAssessmentInput = z.infer<typeof CreateAssessmentInput>;

export const AdvanceAssessmentInput = z.object({
  to: AiChangeStageEnum,
  hazardIds: z.array(z.string()).optional(),
  controlIds: z.array(z.string()).optional(),
  baselineReleaseIds: z.array(z.string()).optional(),
  verificationRefs: z.array(z.string()).optional()
}).strict();
export type AdvanceAssessmentInput = z.infer<typeof AdvanceAssessmentInput>;

export interface AiWorkDesignAssessmentView {
  id: string;
  tenantId: string;
  profileId: string;
  profileVersion: number;
  stage: AiChangeStage;
  hazardIds: string[];
  controlIds: string[];
  baselineReleaseIds: string[];
  verificationRefs: string[];
  version: number;
  profile?: AiChangeProfileView;
  assuranceSummary?: {
    openHazardsCount: number;
    pendingControlsCount: number;
    verifiedControlsCount: number;
  };
  performanceSummary?: {
    evaluationsCount: number;
    permittedClaims: string[];
  };
}
