// backend/src/domains/sector-legal/index.ts
// Domain S13: Legal Professional Services Sector Pack & Mapping Engine
// Standards: Playbook B5 §3 Step 3 (Sector pack contract: Legal)
// Regulatory: SRA Workplace Culture Guidance (2023), Health and Safety at Work etc. Act 1974 §2, ISO 45003:2021 §6.1.2.1

import { z } from "zod";
import { AppError } from "../../platform/errors";
import { evaluateNeutralFatigueSurge, legalMapping } from "../lifecycle/sector";

export const PracticeAreaEnum = z.enum([
  "COMMERCIAL_LITIGATION",
  "CORPORATE_MA",
  "REGULATORY_INVESTIGATION",
  "ARBITRATION"
]);
export type PracticeArea = z.infer<typeof PracticeAreaEnum>;

export const DemandWindowEnum = z.enum([
  "TRIAL_PREP",
  "TRIAL",
  "COURT_HEARING",
  "CLOSING",
  "CLOSING_TRANSACTION",
  "FILING_DEADLINE",
  "DISCOVERY"
]);
export type DemandWindow = z.infer<typeof DemandWindowEnum>;

/**
 * Strict schema for Legal Matter metadata.
 * Physical Minimization: Only work-system metadata is ingested.
 * Substantive legal work product, client confidential notes, and billing amounts are strictly forbidden.
 */
export const LegalMatterSchema = z.object({
  matterId: z.string().min(1).max(64),
  matterTitle: z.string().min(1).max(128),
  practiceArea: PracticeAreaEnum,
  currentPhase: DemandWindowEnum,
  jurisdiction: z.enum(["EWHC", "UK_TRIBUNAL", "LCIA_ARBITRATION", "COMPETITION_APPEAL_TRIBUNAL"]),
  leadPartnerId: z.string().uuid(),
  activeWindowStart: z.string().datetime(),
  activeWindowEnd: z.string().datetime()
}).strict(); // .strict() rejects any unauthorized or prohibited fields!

export type LegalMatter = z.infer<typeof LegalMatterSchema>;

export interface NeutralWorkItem {
  kind: "WORK_ITEM";
  externalRef: string;
  unit: string;
  demandWindow: string;
  timing: {
    startUtc: string;
    endUtc: string;
  };
}

/**
 * Prohibited fields list per Constitutional boundaries and SRA confidentiality
 */
export const FORBIDDEN_LEGAL_FIELDS = [
  "substantiveWorkProduct",
  "clientConfidentialNotes",
  "privilegedAdvice",
  "billingRate",
  "feeEarned",
  "individualLawyerRanking",
  "individualScore"
];

/**
 * Validates that an incoming payload contains zero prohibited surveillance or privileged legal fields.
 */
export function assertLegalBoundaryCompliance(payload: Record<string, unknown>): void {
  for (const forbidden of FORBIDDEN_LEGAL_FIELDS) {
    if (forbidden in payload) {
      throw new AppError(
        "VALIDATION",
        `Constitutional Boundary Violation: Field '${forbidden}' is strictly prohibited. Privileged legal advice, billing rates, and individual rankings cannot enter persistence.`
      );
    }
  }
}

/**
 * Maps sector-specific legal matter into Abate's domain-neutral WORK_ITEM representation.
 */
export function mapMatterToWorkItem(matter: LegalMatter): NeutralWorkItem {
  return {
    kind: "WORK_ITEM",
    externalRef: matter.matterId,
    unit: matter.practiceArea,
    demandWindow: matter.currentPhase,
    timing: {
      startUtc: matter.activeWindowStart,
      endUtc: matter.activeWindowEnd
    }
  };
}

export interface LegalFatigueAssessment {
  matterId: string;
  practiceArea: PracticeArea;
  currentPhase: DemandWindow;
  hasFatigueSurge: boolean;
  consecutiveLateNightsCount: number;
  statutoryReference: string;
  applicableGate: "SUPERVISORY_PARTNER_CONSULTATION" | "STANDARD_APPROVAL";
  regulatoryNotice: string;
}

/**
 * Evaluates whether work intervals during a demand window violate SRA 2023 Workplace Culture thresholds
 * (e.g. 3 or more consecutive evenings with work past 20:00 UTC during a TRIAL_PREP or CLOSING window).
 */
export function evaluateLegalFatigueSurge(
  matter: LegalMatter,
  intervals: Array<{ startUtc: string; endUtc: string }>
): LegalFatigueAssessment {
  const neutral = evaluateNeutralFatigueSurge(
    {
      workItemId: matter.matterId,
      unit: matter.practiceArea,
      demandWindow: matter.currentPhase
    },
    intervals,
    legalMapping.fatigueRule
  );

  const hasFatigueSurge = neutral.hasFatigueSurge;

  return {
    matterId: matter.matterId,
    practiceArea: matter.practiceArea,
    currentPhase: matter.currentPhase,
    hasFatigueSurge,
    consecutiveLateNightsCount: neutral.consecutiveLateNightsCount,
    statutoryReference: hasFatigueSurge
      ? "SRA Workplace Culture Guidance 2023 §3.2 & ISO 45003:2021 §6.1.2.1"
      : "SRA Baseline Practice Standards",
    applicableGate: hasFatigueSurge ? "SUPERVISORY_PARTNER_CONSULTATION" : "STANDARD_APPROVAL",
    regulatoryNotice: hasFatigueSurge
      ? "SURGE ALERT: 3+ consecutive late-night drafting sessions detected during trial preparation. Under SRA 2023 guidelines, closing this hazard requires formal Supervisory Partner Consultation and workload re-balancing."
      : "Within acceptable boundary variance. Normal risk governance applies."
  };
}
