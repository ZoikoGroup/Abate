// frontend/src/utils/vocabulary.ts
import type { TenantSectorProfile } from "../api/client";

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
