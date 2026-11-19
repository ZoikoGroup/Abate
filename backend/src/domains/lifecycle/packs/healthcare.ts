// backend/src/domains/lifecycle/packs/healthcare.ts
// Healthcare Sector Pack (PREVIEW).
//
// Authored here: vocabulary, demand windows, and the fields the sector must never ingest. These are
// minimization rules, not regulatory claims.
// NOT authored here: statutory citations, retention durations, and shift-pattern thresholds for clinical
// rotas. Those come from the Legal & Policy Lead. Until they are supplied the pack stays PREVIEW:
// it is selectable, it is not claimed as launched, and the neutral ISO 45003 wording applies.
//
// The fatigue rule below is the neutral default (3 consecutive evenings past 20:00 UTC). Clinical night-shift
// patterns differ from office patterns, so treat it as a placeholder pending that review.
import { SectorPackDefinition, SectorVocabulary } from "../sector-pack";

export const HEALTHCARE_VOCABULARY: SectorVocabulary = {
  workItem: "Care Episode",
  workItems: "Care Episodes",
  unit: "Service Line",
  demandWindow: "Surge / Pressure Window",
  supervisor: "Clinical Lead"
};

export const healthcarePack: SectorPackDefinition = {
  sectorKey: "HEALTHCARE",
  packKey: "healthcare-preview",
  acceptedPackKeys: ["healthcare-preview"],
  bindingMatchers: ["healthcare"],
  status: "PREVIEW",
  displayName: "Healthcare Sector Pack (Preview)",
  vocabulary: HEALTHCARE_VOCABULARY,
  workItemFields: { externalRef: ["episodeId"], unit: ["serviceLine"] },
  demandWindows: ["ROUTINE_OPERATIONS", "WINTER_PRESSURE", "SURGE_CAPACITY", "OUTBREAK_RESPONSE"],
  highDemandWindows: ["WINTER_PRESSURE", "SURGE_CAPACITY", "OUTBREAK_RESPONSE"],
  fatigueRule: {
    highDemandWindows: ["WINTER_PRESSURE", "SURGE_CAPACITY", "OUTBREAK_RESPONSE"],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 20,
    earlyMorningUtcHour: 6
  },
  forbidden: [
    "patientIdentifier",
    "clinicalNotes",
    "diagnosisCode",
    "medicationRecord",
    "individualClinicianRanking"
  ],
  ui: {
    consultationActions: [
      { value: "REALLOCATE_SHIFT_COVER", label: "Reallocate shift cover to buffer late-evening work" },
      { value: "ESCALATE_STAFFING_SUPPORT", label: "Escalate for additional staffing support" },
      { value: "PROTECTED_REST_PERIOD", label: "Impose a protected rest period" }
    ],
    decoyFields: [
      { field: "patientIdentifier", label: "Inject Patient Identifier", value: "PATIENT-0001" },
      { field: "clinicalNotes", label: "Inject Clinical Notes", value: "Confidential clinical notes." },
      { field: "individualClinicianRanking", label: "Inject Individual Clinician Ranking", value: 1 }
    ]
  },
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "Healthcare preview pack: sector rules are pending Legal & Policy Lead review. Not a launched commercial pack.",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
