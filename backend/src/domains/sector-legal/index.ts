// backend/src/domains/sector-legal/index.ts
// Domain S13: Legal Professional Services adapter over the sector-neutral work-item module.
// Standards: Playbook B5 §3 Step 3 (Sector pack contract: Legal)
// Regulatory: SRA Workplace Culture Guidance (2023), Health and Safety at Work etc. Act 1974 §2, ISO 45003:2021 §6.1.2.1
//
// This file only translates legal field names (matter, practice area, phase, lead partner) to and from the
// neutral work item. Rules, forbidden fields and notice wording come from the legal pack in
// lifecycle/packs/legal.ts, so nothing legal-specific is decided here.

import { z } from "zod";
import { legalMapping } from "../lifecycle/sector";
import {
  NeutralWorkItem,
  SectorWorkItem,
  UNIVERSAL_FORBIDDEN_FIELDS,
  assertSectorBoundaryCompliance,
  evaluateSectorFatigue,
  mapToNeutralWorkItem
} from "../sector-work";

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
 * Physical Minimization: only work-system metadata is ingested.
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
}).strict(); // .strict() rejects any unauthorized or prohibited fields

export type LegalMatter = z.infer<typeof LegalMatterSchema>;

export type { NeutralWorkItem as NeutralWorkItem };

/** Prohibited fields, derived from the legal pack plus the universal list. */
export const FORBIDDEN_LEGAL_FIELDS: string[] = Array.from(
  new Set<string>([...UNIVERSAL_FORBIDDEN_FIELDS, ...legalMapping.forbidden])
);

/** Throws if the payload carries any prohibited surveillance, billing or privileged field. */
export function assertLegalBoundaryCompliance(payload: Record<string, unknown>): void {
  assertSectorBoundaryCompliance(legalMapping, payload);
}

export function legalMatterToWorkItem(matter: LegalMatter): SectorWorkItem {
  return {
    externalRef: matter.matterId,
    title: matter.matterTitle,
    unit: matter.practiceArea,
    demandWindow: matter.currentPhase,
    jurisdiction: matter.jurisdiction,
    accountableReviewerId: matter.leadPartnerId,
    activeWindowStart: matter.activeWindowStart,
    activeWindowEnd: matter.activeWindowEnd
  };
}

/** Re-validates through the legal schema, so a non-legal work item can never leak out as a matter. */
export function workItemToLegalMatter(item: SectorWorkItem): LegalMatter {
  return LegalMatterSchema.parse({
    matterId: item.externalRef,
    matterTitle: item.title,
    practiceArea: item.unit,
    currentPhase: item.demandWindow,
    jurisdiction: item.jurisdiction,
    leadPartnerId: item.accountableReviewerId,
    activeWindowStart: item.activeWindowStart,
    activeWindowEnd: item.activeWindowEnd
  });
}

/** Maps a legal matter into Abate's domain-neutral WORK_ITEM representation. */
export function mapMatterToWorkItem(matter: LegalMatter): NeutralWorkItem {
  return mapToNeutralWorkItem(legalMatterToWorkItem(matter));
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
 * (for example 3 or more consecutive evenings with work past 20:00 UTC during a TRIAL_PREP or CLOSING window).
 */
export function evaluateLegalFatigueSurge(
  matter: LegalMatter,
  intervals: Array<{ startUtc: string; endUtc: string }>
): LegalFatigueAssessment {
  const a = evaluateSectorFatigue(legalMapping, legalMatterToWorkItem(matter), intervals);
  return {
    matterId: matter.matterId,
    practiceArea: matter.practiceArea,
    currentPhase: matter.currentPhase,
    hasFatigueSurge: a.hasFatigueSurge,
    consecutiveLateNightsCount: a.consecutiveLateNightsCount,
    statutoryReference: a.statutoryReference,
    applicableGate: a.applicableGate as LegalFatigueAssessment["applicableGate"],
    regulatoryNotice: a.regulatoryNotice
  };
}
