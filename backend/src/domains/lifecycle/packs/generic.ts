// backend/src/domains/lifecycle/packs/generic.ts
// Neutral, sector-agnostic baseline. Used when no sector pack is bound to a tenant.
import { DEFAULT_NEUTRAL_FATIGUE_RULE, SectorPackDefinition, SectorVocabulary } from "../sector-pack";

export const GENERIC_VOCABULARY: SectorVocabulary = {
  workItem: "Work Item",
  workItems: "Work Items",
  unit: "Unit / Team",
  demandWindow: "Demand Window",
  supervisor: "Accountable Reviewer"
};

export const genericPack: SectorPackDefinition = {
  sectorKey: "GENERIC",
  packKey: "generic-work-design",
  acceptedPackKeys: ["generic-work-design"],
  bindingMatchers: [],
  status: "BASELINE",
  displayName: "Neutral Work-Design Core",
  vocabulary: GENERIC_VOCABULARY,
  workItemFields: { externalRef: ["workItemId", "externalRef"], unit: ["unit"] },
  workItemFallbacks: { externalRef: "WORK-ITEM-UNKNOWN", unit: "GENERAL_TEAM" },
  demandWindows: ["BASELINE", "PEAK_PERIOD", "HIGH_DEMAND", "DEADLINE_WINDOW"],
  highDemandWindows: ["PEAK_PERIOD", "HIGH_DEMAND", "DEADLINE_WINDOW"],
  fatigueRule: DEFAULT_NEUTRAL_FATIGUE_RULE,
  forbidden: ["clientConfidentialNotes"],
  requiredGates: ["APPROVAL"],
  claimScope: "Neutral work-design core active (no sector-specific overlay bound). Enabled packs today: {{launchedPacks}}.",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
