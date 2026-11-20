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
  rules: [
    {
      ruleId: "SW_LATE_EVENING_CUTOVER",
      title: "Consecutive Late-Evening Release / Incident Work",
      type: "CONSECUTIVE_LATE_NIGHTS",
      highDemandWindows: ["RELEASE_CUTOVER", "INCIDENT_RESPONSE"],
      consecutiveLateNights: 3,
      lateEveningUtcHour: 20,
      earlyMorningUtcHour: 6,
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (pending Policy & Governance Lead review)",
      rationale: "Three or more consecutive late-evening sessions during release cutovers or active incidents trigger engineering manager consultation."
    },
    {
      ruleId: "SW_ON_CALL_WEEKEND_RECOVERY",
      title: "On-Call / Incident Weekend Rest Deficit",
      type: "CONSECUTIVE_ON_CALL_OR_WEEKEND",
      maxConsecutiveWeekendDays: 1,
      minUninterruptedRestHours: 36,
      appliesToWindows: ["ON_CALL_ROTATION", "INCIDENT_RESPONSE", "RELEASE_CUTOVER"],
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (on-call rest guidance pending Policy & Governance Lead review)",
      rationale: "Detects unbuffered weekend on-call or incident load lacking an uninterrupted 36-hour recovery window."
    },
    {
      ruleId: "SW_INCIDENT_INTER_SHIFT_REST",
      title: "Post-Incident Inter-Shift Recovery Gap (< 11h)",
      type: "MIN_INTER_SHIFT_REST",
      minRestHours: 11,
      maxShortRestTransitions: 0,
      appliesToWindows: ["INCIDENT_RESPONSE", "RELEASE_CUTOVER"],
      requiredGate: "REVIEW",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (pending Policy & Governance Lead review)",
      rationale: "Flags short overnight turnarounds following late incident response so protected recovery time is scheduled."
    }
  ],
  jurisdictionOverlays: [
    {
      overlayKey: "software-uk-preview",
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
      overlayKey: "software-eu-preview",
      jurisdictionCode: "EU",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Preview pack only: works-council / right-to-disconnect citations pending Policy & Governance Lead review."
    }
  ],
  forbidden: [
    "sourceCode",
    "commitDiff",
    "prCount",
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
