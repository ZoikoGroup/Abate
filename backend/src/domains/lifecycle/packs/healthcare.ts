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
  rules: [
    {
      ruleId: "HC_INTER_SHIFT_REST",
      title: "Minimum Inter-Shift Recovery Rest Gap (< 11h)",
      type: "MIN_INTER_SHIFT_REST",
      minRestHours: 11,
      maxShortRestTransitions: 0,
      appliesToWindows: ["ROUTINE_OPERATIONS", "WINTER_PRESSURE", "SURGE_CAPACITY", "OUTBREAK_RESPONSE"],
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (clinical rota statutory citations pending Policy & Governance Lead review)",
      rationale: "Shift-aware recovery check: flags rota transitions with less than 11 hours of rest between consecutive shifts without falsely flagging standard night shifts."
    },
    {
      ruleId: "HC_SURGE_WINDOW_DURATION",
      title: "Sustained Surge / Pressure Window Duration",
      type: "HIGH_DEMAND_WINDOW_DURATION",
      highDemandWindows: ["WINTER_PRESSURE", "SURGE_CAPACITY", "OUTBREAK_RESPONSE"],
      maxConsecutiveDays: 14,
      requiredGate: "REVIEW",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (pending Policy & Governance Lead review)",
      rationale: "Sustained winter pressure, surge capacity, or outbreak windows exceeding 14 days trigger mandatory staffing-support review."
    },
    {
      ruleId: "HC_ROLLING_WEEKLY_HOURS",
      title: "Rolling Cohort Weekly Hours Envelope",
      type: "ROLLING_WEEKLY_HOURS_CAP",
      maxWeeklyHours: 48,
      windowDays: 119,
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (jurisdiction working-time citation pending Policy & Governance Lead review)",
      rationale: "Monitors cohort-level average weekly hours over a rolling reference window without scoring or ranking individual clinicians."
    }
  ],
  jurisdictionOverlays: [
    {
      overlayKey: "healthcare-uk-preview",
      jurisdictionCode: "UK",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Preview pack only: zero retention policy active until Policy & Governance Lead approves jurisdiction pack."
    },
    {
      overlayKey: "healthcare-us-preview",
      jurisdictionCode: "US",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Preview pack only: strict zero-PHI perimeter; zero retention policy active until approved."
    }
  ],
  forbidden: [
    "patientIdentifier",
    "nhsNumber",
    "mrn",
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
