// frontend/src/utils/sector-simulations.ts
// Industry-specific simulation presets and cross-sector boundary decoy catalog.
// Allows interactive verification of multi-rule evaluation and physical minimization gates
// across Healthcare, Software & IT, Accounting, Financial Services, and Legal Practice.

export interface SimulationPreset {
  sectorKey: string;
  badge: string;
  title: string;
  description: string;
  simulatedRef: string;
  unit: string;
  demandWindow: string;
  intervals: Array<{ startUtc: string; endUtc: string }>;
}

export const SIMULATION_PRESETS: Record<string, SimulationPreset> = {
  HEALTHCARE: {
    sectorKey: "HEALTHCARE",
    badge: "🏥 Healthcare (Rota Rests)",
    title: "Clinical Rota Night Shifts (< 11h Rest)",
    description: "3 consecutive 12-hour shifts with only 8-hour recovery gaps between shifts during Winter Pressure / Surge Capacity.",
    simulatedRef: "SIM-HC-ROTA-001",
    unit: "ACUTE_MEDICINE",
    demandWindow: "SURGE_CAPACITY",
    intervals: [
      { startUtc: "2026-03-01T19:00:00Z", endUtc: "2026-03-02T07:00:00Z" },
      { startUtc: "2026-03-02T15:00:00Z", endUtc: "2026-03-03T03:00:00Z" },
      { startUtc: "2026-03-03T11:00:00Z", endUtc: "2026-03-03T23:00:00Z" }
    ]
  },
  SOFTWARE_IT: {
    sectorKey: "SOFTWARE_IT",
    badge: "💻 Software & IT (On-Call)",
    title: "Dual-Weekend Pager Duty & Rapid Turnaround",
    description: "2 consecutive weekends with on-call pager shifts and rapid turnaround during Incident Response.",
    simulatedRef: "SIM-IT-SRE-001",
    unit: "PLATFORM_SQUAD",
    demandWindow: "INCIDENT_RESPONSE",
    intervals: [
      { startUtc: "2026-03-07T10:00:00Z", endUtc: "2026-03-07T22:00:00Z" },
      { startUtc: "2026-03-08T10:00:00Z", endUtc: "2026-03-08T22:00:00Z" },
      { startUtc: "2026-03-14T10:00:00Z", endUtc: "2026-03-14T22:00:00Z" },
      { startUtc: "2026-03-15T10:00:00Z", endUtc: "2026-03-15T22:00:00Z" }
    ]
  },
  ACCOUNTING: {
    sectorKey: "ACCOUNTING",
    badge: "📊 Accounting (Busy Season)",
    title: "Busy-Season Filing & 55h Rolling Average",
    description: "Consecutive late-evening audit filings exceeding rolling 48-hour envelope during Busy Season.",
    simulatedRef: "SIM-ACC-AUDIT-001",
    unit: "STATUTORY_AUDIT",
    demandWindow: "BUSY_SEASON",
    intervals: [
      { startUtc: "2026-03-01T08:00:00Z", endUtc: "2026-03-01T21:00:00Z" },
      { startUtc: "2026-03-02T08:00:00Z", endUtc: "2026-03-02T21:00:00Z" },
      { startUtc: "2026-03-03T08:00:00Z", endUtc: "2026-03-03T21:00:00Z" },
      { startUtc: "2026-03-04T08:00:00Z", endUtc: "2026-03-04T21:00:00Z" },
      { startUtc: "2026-03-05T08:00:00Z", endUtc: "2026-03-05T21:00:00Z" }
    ]
  },
  FINANCE: {
    sectorKey: "FINANCE",
    badge: "📈 Finance (Market Volatility)",
    title: "Quarter-End Settlement & Market Volatility Crunch",
    description: "4 consecutive late evenings past 21:00 UTC during volatile market close.",
    simulatedRef: "SIM-FIN-DESK-001",
    unit: "GLOBAL_MACRO",
    demandWindow: "MARKET_VOLATILITY",
    intervals: [
      { startUtc: "2026-03-01T07:00:00Z", endUtc: "2026-03-01T22:00:00Z" },
      { startUtc: "2026-03-02T07:00:00Z", endUtc: "2026-03-02T22:30:00Z" },
      { startUtc: "2026-03-03T07:00:00Z", endUtc: "2026-03-03T23:00:00Z" },
      { startUtc: "2026-03-04T07:00:00Z", endUtc: "2026-03-04T22:15:00Z" }
    ]
  },
  LEGAL: {
    sectorKey: "LEGAL",
    badge: "⚖️ Legal (Trial Prep)",
    title: "High Court Trial Prep 4 Consecutive Late Nights",
    description: "4 consecutive evenings past 20:00 UTC during High Court Commercial Trial Prep.",
    simulatedRef: "SIM-LEG-TRIAL-001",
    unit: "COMMERCIAL_LITIGATION",
    demandWindow: "TRIAL_PREP",
    intervals: [
      { startUtc: "2026-03-01T08:30:00Z", endUtc: "2026-03-01T21:30:00Z" },
      { startUtc: "2026-03-02T08:30:00Z", endUtc: "2026-03-02T22:00:00Z" },
      { startUtc: "2026-03-03T08:30:00Z", endUtc: "2026-03-03T21:45:00Z" },
      { startUtc: "2026-03-04T08:30:00Z", endUtc: "2026-03-04T22:30:00Z" }
    ]
  }
};

export interface CrossSectorDecoy {
  field: string;
  label: string;
  value: string | number;
  category: string;
}

export const CROSS_SECTOR_DECOY_CATALOG: CrossSectorDecoy[] = [
  { field: "patientIdentifier", label: "Patient NHS / MRN Identifier", value: "NHS-992-110-4491", category: "Healthcare PHI" },
  { field: "clinicalNotes", label: "Substantive Clinical Consultation Notes", value: "Patient admitted with acute respiratory distress.", category: "Healthcare PHI" },
  { field: "commitDiff", label: "Raw Git Diff / Source Patch", value: "diff --git a/auth.ts\n+token = bypass()", category: "Software & IT" },
  { field: "individualVelocity", label: "Individual Developer Velocity Ranking", value: 42, category: "Software & IT" },
  { field: "clientWorkpapers", label: "Client Audit Workpapers & Balances", value: "AUDIT_WORKPAPERS_Q4_CONFIDENTIAL.xlsx", category: "Accounting & Audit" },
  { field: "tradeTickets", label: "Trade Execution Tickets & Order IDs", value: "ORD-99823-FILL BUY 50k EQ", category: "Financial Services" },
  { field: "mnpiContent", label: "Material Non-Public Information (MNPI)", value: "CONFIDENTIAL M&A MERGER RATIO 1:1.4", category: "Financial Services" },
  { field: "individualPnL", label: "Individual Trader PnL", value: 185000.75, category: "Financial Services" },
  { field: "caseName", label: "Confidential Case Dispute Name", value: "Alpha Corp v. Beta Ltd Injunction", category: "Legal Privilege" },
  { field: "hourlyBillingRate", label: "Individual Hourly Billing Rate", value: 850, category: "Legal Privilege" }
];
