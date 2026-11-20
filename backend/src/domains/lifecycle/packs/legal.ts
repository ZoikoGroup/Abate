// backend/src/domains/lifecycle/packs/legal.ts
// UK Legal Sector Pack (SRA 2023). Playbook B5 §3 Step 3.
// Matters, practice areas and trial/closing windows map onto neutral core concepts.
import { SectorPackDefinition, SectorVocabulary } from "../sector-pack";

export const LEGAL_VOCABULARY: SectorVocabulary = {
  workItem: "Matter",
  workItems: "Matters",
  unit: "Practice Area",
  demandWindow: "Trial / Closing Window",
  supervisor: "Supervisory Partner"
};

export const legalPack: SectorPackDefinition = {
  sectorKey: "LEGAL",
  packKey: "legal-uk-sra",
  acceptedPackKeys: ["legal-uk-sra", "legal-uk-bar", "sector-legal"],
  bindingMatchers: ["legal", "bar"],
  status: "LAUNCHED",
  displayName: "UK Legal Sector Pack (SRA 2023)",
  launchTag: "LEGAL_UK",
  vocabulary: LEGAL_VOCABULARY,
  workItemFields: { externalRef: ["matterId"], unit: ["practiceArea"] },
  workItemUnits: ["COMMERCIAL_LITIGATION", "CORPORATE_MA", "REGULATORY_INVESTIGATION", "ARBITRATION"],
  jurisdictions: ["EWHC", "UK_TRIBUNAL", "LCIA_ARBITRATION", "COMPETITION_APPEAL_TRIBUNAL"],
  demandWindows: ["TRIAL_PREP", "TRIAL", "COURT_HEARING", "CLOSING", "CLOSING_TRANSACTION", "FILING_DEADLINE", "DISCOVERY"],
  highDemandWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
  fatigueRule: {
    highDemandWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 20,
    earlyMorningUtcHour: 6
  },
  rules: [
    {
      ruleId: "LEGAL_LATE_EVENING_SURGE",
      title: "Consecutive Late-Evening Drafting During Trial / Closing",
      type: "CONSECUTIVE_LATE_NIGHTS",
      highDemandWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
      consecutiveLateNights: 3,
      lateEveningUtcHour: 20,
      earlyMorningUtcHour: 6,
      requiredGate: "CONSULTATION",
      citationStatus: "APPROVED",
      reference: "SRA Workplace Culture Guidance 2023 §3.2 & ISO 45003:2021 §6.1.2.1",
      rationale: "Three or more consecutive late-evening work sessions during trial preparation or transaction closing require supervisory partner consultation and workload re-balancing."
    },
    {
      ruleId: "LEGAL_WEEKEND_REST_DEFICIT",
      title: "Unbuffered Weekend Drafting During Trial / Closing",
      type: "CONSECUTIVE_ON_CALL_OR_WEEKEND",
      maxConsecutiveWeekendDays: 1,
      minUninterruptedRestHours: 36,
      appliesToWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (UK working-time statutory citation pending Legal & Policy Lead review)",
      rationale: "Sustained weekend drafting across both Saturday and Sunday without a protected rest buffer indicates unbuffered matter demand."
    },
    {
      ruleId: "LEGAL_SUSTAINED_PEAK_DURATION",
      title: "Sustained High-Demand Window Duration",
      type: "HIGH_DEMAND_WINDOW_DURATION",
      highDemandWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
      maxConsecutiveDays: 14,
      requiredGate: "REVIEW",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (placeholder pending Legal & Policy Lead review)",
      rationale: "High-demand trial or closing windows running beyond 14 consecutive days require capacity review and rotation planning."
    }
  ],
  jurisdictionOverlays: [
    {
      overlayKey: "legal-uk-sra-overlay",
      jurisdictionCode: "UK",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "DRAFT",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [
        "SRA Workplace Culture Guidance 2023 §3.2 (pending formal legal sign-off in open-signoffs.md)",
        "ISO 45003:2021 §6.1.2.1"
      ],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Synthetic default retention (90d–730d) pending Data Owner & Legal sign-off in docs/governance/open-signoffs.md."
    },
    {
      overlayKey: "legal-eu-preview-overlay",
      jurisdictionCode: "EU",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "No EU statutory retention schedule approved yet; zero automated deletion until configured."
    }
  ],
  forbidden: ["clientConfidentialNotes", "privilegedAdvice", "billingRate", "feeEarned", "individualLawyerRanking"],
  ui: {
    navLabel: "Legal Sector Pack (SRA 2023)",
    sectorBadge: "SECTOR: LEGAL SERVICES",
    badges: ["SRA-Aligned Work-Design Review", "ISO 45003 §6.1.2.1", "HSWA 1974 §2"],
    heading: "UK Legal Practice & Workplace Culture (SRA 2023 / Domain S13)",
    subtitle: "Sector-specific psychosocial risk management for law firms, barristers' chambers, and legal departments. Enforces trial window fatigue caps, court deadline buffers, and mandatory supervisory partner consultation.",
    panelTitle: "UK Legal Practice: Matters, Demand Windows & Fatigue Triggers",
    panelDescription: "Maps legal matters to neutral work items. Detects unbuffered evening drafting during critical trial prep windows under SRA Workplace Culture guidance.",
    mandatoryNote: "Mandatory: Supervisory Partner Consultation required prior to hazard disposition closure.",
    boundaryTitle: "Constitutional Boundary Protection for Legal Services",
    boundaryText: "Physical minimization is active: zero client confidential information, substantive legal work product, billing rates, or individual fee-earner productivity rankings enter persistence. Only neutral work cadence metadata is ingested.",
    listTitle: "Legal Matters & Demand Windows",
    unitFilterLabel: "Filter Practice Area",
    allUnitsLabel: "All Practice Areas",
    unitLabels: {
      COMMERCIAL_LITIGATION: "Commercial Litigation",
      CORPORATE_MA: "Corporate M&A",
      REGULATORY_INVESTIGATION: "Regulatory Investigation",
      ARBITRATION: "Arbitration"
    },
    fatigueButtonLabel: "SRA Fatigue Check",
    fatigueCardTitle: "SRA 2023 Workplace Culture Fatigue Audit",
    surgeBadge: "SRA SURGE ALERT: FATIGUE DETECTED",
    compliantBadge: "WITHIN THRESHOLD: NORMAL VARIANCE",
    thresholdNote: "SRA Threshold: ≥ 3 consecutive nights with unbuffered work past 20:00 during trial/closing triggers mandatory supervisory intervention.",
    consultationTitle: "Mandatory Supervisory Partner Consultation Gate",
    consultationSignerLabel: "Supervisory Partner",
    consultationActions: [
      { value: "REALLOCATE_SECONDARY_ASSOCIATE", label: "Deploy Secondary Associate to Buffer Late Drafting" },
      { value: "EXTEND_FILING_DEADLINE_COURT_APPLICATION", label: "Apply for Procedural Filing Buffer (CPR 3.1(2)(a))" },
      { value: "MANDATORY_OFFLINE_REST_DAY", label: "Impose Mandatory Post-Hearing Protected Rest Period" }
    ],
    decoyFields: [
      { field: "privilegedAdvice", label: "Inject Privileged Legal Advice", value: "Confidential trial strategy notes regarding litigation risk." },
      { field: "billingRate", label: "Inject Hourly Billing Rate", value: 950 },
      { field: "individualLawyerRanking", label: "Inject Individual Lawyer Ranking", value: 1 }
    ]
  },
  fatigueNotice: {
    surgeGateLabel: "SUPERVISORY_PARTNER_CONSULTATION",
    standardGateLabel: "STANDARD_APPROVAL",
    surgeReference: "SRA Workplace Culture Guidance 2023 §3.2 & ISO 45003:2021 §6.1.2.1",
    baselineReference: "SRA Baseline Practice Standards",
    surgeNotice: "SURGE ALERT: 3+ consecutive late-night drafting sessions detected during trial preparation. Under SRA 2023 guidelines, closing this hazard requires formal Supervisory Partner Consultation and workload re-balancing.",
    baselineNotice: "Within acceptable boundary variance. Normal risk governance applies."
  },
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "UK Legal Sector Pack (SRA 2023) active for this tenant.",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
