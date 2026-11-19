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
  forbidden: ["clientTaxReturns"],
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "Portability test fixture only (Accounting is not a launched commercial pack).",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
