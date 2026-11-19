// backend/src/domains/lifecycle/packs/software-it.ts
// Software and IT Sector Pack (PREVIEW).
//
// Authored here: vocabulary, demand windows, and the fields the sector must never ingest. These are
// minimization rules, not regulatory claims.
// NOT authored here: statutory citations or retention durations. Those come from the Legal & Policy Lead.
// Until they are supplied the pack stays PREVIEW and the neutral ISO 45003 wording applies.
//
// Individual engineering metrics (velocity, commit counts) are exactly the kind of individual
// surveillance the platform refuses, so they are forbidden fields here.
import { SectorPackDefinition, SectorVocabulary } from "../sector-pack";

export const SOFTWARE_IT_VOCABULARY: SectorVocabulary = {
  workItem: "Delivery Item",
  workItems: "Delivery Items",
  unit: "Squad",
  demandWindow: "Release / Incident Window",
  supervisor: "Engineering Manager"
};

export const softwareItPack: SectorPackDefinition = {
  sectorKey: "SOFTWARE_IT",
  packKey: "software-it-preview",
  acceptedPackKeys: ["software-it-preview"],
  bindingMatchers: ["software"],
  status: "PREVIEW",
  displayName: "Software & IT Sector Pack (Preview)",
  vocabulary: SOFTWARE_IT_VOCABULARY,
  workItemFields: { externalRef: ["deliveryId"], unit: ["squad"] },
  demandWindows: ["PLANNING", "RELEASE_CUTOVER", "INCIDENT_RESPONSE", "ON_CALL_ROTATION"],
  highDemandWindows: ["RELEASE_CUTOVER", "INCIDENT_RESPONSE"],
  fatigueRule: {
    highDemandWindows: ["RELEASE_CUTOVER", "INCIDENT_RESPONSE"],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 20,
    earlyMorningUtcHour: 6
  },
  forbidden: [
    "sourceCode",
    "customerData",
    "individualVelocity",
    "individualCommitCount",
    "individualPerformanceRanking"
  ],
  ui: {
    consultationActions: [
      { value: "REALLOCATE_ON_CALL", label: "Reallocate on-call cover to buffer late-evening work" },
      { value: "DEFER_RELEASE_SCOPE", label: "Defer release scope to protect the team" },
      { value: "PROTECTED_REST_PERIOD", label: "Impose a protected rest period after the incident" }
    ],
    decoyFields: [
      { field: "sourceCode", label: "Inject Source Code", value: "function secret() { return 1; }" },
      { field: "individualVelocity", label: "Inject Individual Velocity", value: 42 },
      { field: "individualCommitCount", label: "Inject Individual Commit Count", value: 317 }
    ]
  },
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "Software & IT preview pack: sector rules are pending Legal & Policy Lead review. Not a launched commercial pack.",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
