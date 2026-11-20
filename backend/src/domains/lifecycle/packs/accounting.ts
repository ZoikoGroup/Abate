// backend/src/domains/lifecycle/packs/accounting.ts
// Accounting Sector Pack fixture. Architecture test for portability:
// proves the engine is neutral across knowledge sectors without code forks.
import { SectorPackDefinition, SectorVocabulary } from "../sector-pack";

export const ACCOUNTING_VOCABULARY: SectorVocabulary = {
  workItem: "Engagement",
  workItems: "Engagements",
  unit: "Service Line",
  demandWindow: "Busy Season / Close Window",
  supervisor: "Engagement Reviewer"
};

export const accountingPack: SectorPackDefinition = {
  sectorKey: "ACCOUNTING",
  packKey: "accounting-fixture",
  acceptedPackKeys: ["accounting-fixture"],
  bindingMatchers: ["accounting"],
  status: "FIXTURE",
  displayName: "Accounting Portability Fixture",
  vocabulary: ACCOUNTING_VOCABULARY,
  workItemFields: { externalRef: ["engagementId"], unit: ["serviceLine"] },
  demandWindows: ["BUSY_SEASON", "AUDIT_CLOSE", "TAX_DEADLINE"],
  highDemandWindows: ["BUSY_SEASON", "AUDIT_CLOSE"],
  fatigueRule: {
    highDemandWindows: ["BUSY_SEASON", "AUDIT_CLOSE"],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 20,
    earlyMorningUtcHour: 6
  },
  rules: [
    {
      ruleId: "ACC_BUSY_SEASON_LATE_NIGHTS",
      title: "Busy Season / Audit Close Late-Evening Sessions",
      type: "CONSECUTIVE_LATE_NIGHTS",
      highDemandWindows: ["BUSY_SEASON", "AUDIT_CLOSE"],
      consecutiveLateNights: 3,
      lateEveningUtcHour: 20,
      earlyMorningUtcHour: 6,
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (architecture portability fixture)",
      rationale: "Consecutive late-evening work during busy season or audit close triggers engagement reviewer consultation."
    },
    {
      ruleId: "ACC_WEEKEND_REST_DEFICIT",
      title: "Filing Deadline Weekend Recovery Deficit",
      type: "CONSECUTIVE_ON_CALL_OR_WEEKEND",
      maxConsecutiveWeekendDays: 1,
      minUninterruptedRestHours: 36,
      appliesToWindows: ["BUSY_SEASON", "AUDIT_CLOSE", "TAX_DEADLINE"],
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (architecture portability fixture)",
      rationale: "Sustained weekend work across filing deadlines without 36h uninterrupted rest flags workload rebalancing."
    },
    {
      ruleId: "ACC_ROLLING_WEEKLY_HOURS",
      title: "Rolling Busy-Season Weekly Hours Cap",
      type: "ROLLING_WEEKLY_HOURS_CAP",
      maxWeeklyHours: 48,
      windowDays: 119,
      requiredGate: "REVIEW",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (architecture portability fixture)",
      rationale: "Tracks cohort-level rolling weekly hours across audit/tax peaks without individual utilization scoring."
    }
  ],
  jurisdictionOverlays: [
    {
      overlayKey: "accounting-uk-fixture",
      jurisdictionCode: "UK",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Portability fixture only; not a launched commercial pack."
    }
  ],
  forbidden: [
    "clientTaxReturns",
    "clientWorkpapers",
    "auditAdjustments",
    "clientFinancials",
    "billableUtilizationRanking"
  ],
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "Portability test fixture only (Accounting is not a launched commercial pack).",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
