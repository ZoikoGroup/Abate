// backend/src/domains/lifecycle/packs/finance.ts
// Financial Services Sector Pack (PREVIEW).
//
// Authored here: vocabulary, demand windows, and the fields the sector must never ingest. These are
// minimization rules, not regulatory claims.
// NOT authored here: statutory citations, retention schedules, and trading conduct boundaries. Those come
// from the Legal & Policy Lead. Until they are supplied the pack stays PREVIEW:
// it is selectable, it is not claimed as launched, and the neutral ISO 45003 wording applies.
import { SectorPackDefinition, SectorVocabulary } from "../sector-pack";

export const FINANCE_VOCABULARY: SectorVocabulary = {
  workItem: "Trading Desk / Portfolio",
  workItems: "Trading Desks & Portfolios",
  unit: "Division",
  demandWindow: "Market Surge / Settlement Window",
  supervisor: "Compliance & Risk Officer"
};

export const financePack: SectorPackDefinition = {
  sectorKey: "FINANCE",
  packKey: "finance-preview",
  acceptedPackKeys: ["finance-preview"],
  bindingMatchers: ["finance", "banking", "trading", "investment"],
  status: "PREVIEW",
  displayName: "Financial Services Sector Pack (Preview)",
  vocabulary: FINANCE_VOCABULARY,
  workItemFields: { externalRef: ["deskRef", "portfolioId"], unit: ["division"] },
  demandWindows: [
    "ROUTINE_MARKETS",
    "MARKET_VOLATILITY",
    "QUARTER_END_CLOSE",
    "REGULATORY_FILING",
    "YEAR_END_SETTLEMENT"
  ],
  highDemandWindows: [
    "MARKET_VOLATILITY",
    "QUARTER_END_CLOSE",
    "REGULATORY_FILING",
    "YEAR_END_SETTLEMENT"
  ],
  fatigueRule: {
    highDemandWindows: [
      "MARKET_VOLATILITY",
      "QUARTER_END_CLOSE",
      "REGULATORY_FILING",
      "YEAR_END_SETTLEMENT"
    ],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 21,
    earlyMorningUtcHour: 6
  },
  rules: [
    {
      ruleId: "FIN_MARKET_VOLATILITY_LATE_NIGHTS",
      title: "Consecutive Late-Evening Market Settlement Crunch",
      type: "CONSECUTIVE_LATE_NIGHTS",
      highDemandWindows: ["MARKET_VOLATILITY", "QUARTER_END_CLOSE", "REGULATORY_FILING", "YEAR_END_SETTLEMENT"],
      consecutiveLateNights: 3,
      lateEveningUtcHour: 21,
      earlyMorningUtcHour: 6,
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (financial conduct references pending Policy & Governance Lead review)",
      rationale: "Detects 3 or more consecutive evenings past 21:00 UTC during volatile markets, quarter-end close, or regulatory filing periods."
    },
    {
      ruleId: "FIN_MANDATORY_BLOCK_LEAVE_REST",
      title: "Mandatory Consecutive Weekend / Block Rest Deficit",
      type: "CONSECUTIVE_ON_CALL_OR_WEEKEND",
      maxConsecutiveWeekendDays: 1,
      minUninterruptedRestHours: 48,
      appliesToWindows: ["ROUTINE_MARKETS", "MARKET_VOLATILITY", "QUARTER_END_CLOSE", "REGULATORY_FILING", "YEAR_END_SETTLEMENT"],
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (FCA/PRA conduct risk guidance pending Policy & Governance Lead review)",
      rationale: "Conduct risk & wellbeing protection: consecutive weekend trading preparation or settlement shifts without 48h block rest trigger supervisory consultation."
    },
    {
      ruleId: "FIN_ROLLING_WEEKLY_HOURS",
      title: "Rolling Trading Desk Weekly Hours Envelope",
      type: "ROLLING_WEEKLY_HOURS_CAP",
      maxWeeklyHours: 55,
      windowDays: 84,
      requiredGate: "REVIEW",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (jurisdiction working-time limits pending Policy & Governance Lead review)",
      rationale: "Monitors cohort-level average weekly hours across trading divisions over a 12-week reference period without tracking individual trader productivity."
    },
    {
      ruleId: "FIN_INTER_SESSION_REST",
      title: "Minimum Inter-Session Rest Gap (< 10h)",
      type: "MIN_INTER_SHIFT_REST",
      minRestHours: 10,
      maxShortRestTransitions: 0,
      appliesToWindows: ["ROUTINE_MARKETS", "MARKET_VOLATILITY", "QUARTER_END_CLOSE", "REGULATORY_FILING", "YEAR_END_SETTLEMENT"],
      requiredGate: "CONSULTATION",
      citationStatus: "PREVIEW_PLACEHOLDER",
      reference: "ISO 45003:2021 §6.1.2.1 (pending Policy & Governance Lead review)",
      rationale: "Detects rapid transitions between international market closing and opening sessions with less than 10 hours rest."
    }
  ],
  jurisdictionOverlays: [
    {
      overlayKey: "finance-uk-pra-preview",
      jurisdictionCode: "UK",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Preview pack only: strict zero-MNPI perimeter; zero retention policy active until approved."
    },
    {
      overlayKey: "finance-us-sec-preview",
      jurisdictionCode: "US",
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: null,
      approvalStatus: "PREVIEW_PLACEHOLDER",
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
      retentionNote: "Preview pack only: SEC/FINRA conduct boundaries pending legal sign-off."
    }
  ],
  forbidden: [
    "tradeTickets",
    "clientPortfolio",
    "mnpiContent",
    "individualPnL",
    "orderBook",
    "accountBalance",
    "traderRanking"
  ],
  ui: {
    consultationActions: [
      { value: "REALLOCATE_DESK_COVERAGE", label: "Reallocate trading desk coverage & handoff" },
      { value: "MANDATE_BLOCK_REST", label: "Mandate protected 48h block rest period" },
      { value: "STAGGER_MARKET_OPENINGS", label: "Stagger market opening & closing assignments" }
    ],
    decoyFields: [
      { field: "tradeTickets", label: "Inject Trade Tickets & Order IDs", value: "ORD-99823-FILL BUY 50000 EQ" },
      { field: "individualPnL", label: "Inject Individual Trader PnL", value: 185000.75 },
      { field: "mnpiContent", label: "Inject Material Non-Public Info (MNPI)", value: "CONFIDENTIAL M&A MERGER RATIO 1:1.4" }
    ]
  },
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "Financial Services preview pack: sector rules are pending Legal & Policy Lead review. Not a launched commercial pack.",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};
