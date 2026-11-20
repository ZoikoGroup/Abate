// frontend/src/utils/vocabulary.ts
import type { SectorUiCopy, TenantSectorProfile } from "../api/client";

export interface SectorDictionary {
  workItem: string;
  workItems: string;
  unit: string;
  demandWindow: string;
  supervisor: string;
}

export const NEUTRAL_VOCABULARY: SectorDictionary = {
  workItem: "Work Item",
  workItems: "Work Items",
  unit: "Unit / Team",
  demandWindow: "Demand Window",
  supervisor: "Accountable Reviewer"
};

export function getSectorVocabulary(profile?: TenantSectorProfile | null): SectorDictionary {
  if (!profile?.vocabulary) return NEUTRAL_VOCABULARY;
  return {
    workItem: profile.vocabulary.workItem || NEUTRAL_VOCABULARY.workItem,
    workItems: profile.vocabulary.workItems || NEUTRAL_VOCABULARY.workItems,
    unit: profile.vocabulary.unit || NEUTRAL_VOCABULARY.unit,
    demandWindow: profile.vocabulary.demandWindow || NEUTRAL_VOCABULARY.demandWindow,
    supervisor: profile.vocabulary.supervisor || NEUTRAL_VOCABULARY.supervisor
  };
}

/** True when a sector pack other than the neutral baseline is active. Falls back to the legacy flag for older backends. */
export function isSectorPackActive(profile?: TenantSectorProfile | null): boolean {
  if (!profile) return false;
  return profile.packActive ?? profile.hasLegalPack;
}

/** Neutral screen wording used only when the backend sends none. Sector packs author their own. */
export const NEUTRAL_UI: SectorUiCopy = {
  navLabel: "Sector Pack",
  sectorBadge: "SECTOR PACK",
  badges: [],
  heading: "Sector Work-Design Review",
  subtitle: "Sector work-design review. Detects unbuffered late-evening work during high-demand windows.",
  panelTitle: "Sector Work Items & Fatigue Triggers",
  panelDescription: "Maps sector work items to neutral work items and detects unbuffered late-evening work.",
  mandatoryNote: "Mandatory: accountable reviewer consultation required prior to hazard disposition closure.",
  boundaryTitle: "Constitutional Boundary Protection",
  boundaryText: "Physical minimization is active: only neutral work cadence metadata is ingested.",
  listTitle: "Work Items & Demand Windows",
  unitFilterLabel: "Filter Unit",
  allUnitsLabel: "All",
  unitLabels: {},
  fatigueButtonLabel: "Fatigue Check",
  fatigueCardTitle: "Workplace Fatigue Audit",
  surgeBadge: "SURGE ALERT: FATIGUE DETECTED",
  compliantBadge: "WITHIN THRESHOLD: NORMAL VARIANCE",
  thresholdNote: "Consecutive late-evening work during a high-demand window triggers mandatory consultation.",
  consultationTitle: "Mandatory Consultation Gate",
  consultationSignerLabel: "Accountable Reviewer",
  consultationSignerDefault: "",
  consultationActions: [{ value: "REALLOCATE_CAPACITY", label: "Reallocate capacity to buffer late-evening work" }],
  decoyFields: [{ field: "individualScore", label: "Inject Individual Productivity Score", value: 1 }]
};

export function getSectorUi(profile?: TenantSectorProfile | null): SectorUiCopy {
  return profile?.ui ?? NEUTRAL_UI;
}

/** Readable label for a unit or demand-window key: the pack's own label first, then Title Case. */
export function labelFor(key: string, labels?: Record<string, string>): string {
  if (labels && labels[key]) return labels[key];
  return key.toLowerCase().split("_").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}
