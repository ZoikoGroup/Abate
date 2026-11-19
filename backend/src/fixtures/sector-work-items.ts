// backend/src/fixtures/sector-work-items.ts
// Demo work items per tenant. SYNTHETIC: titles and references are test data, not client matters.
// Each entry is tagged with the sector it belongs to, so a tenant that switches sector never sees
// items whose windows or units are invalid for the new pack.
import { GOLDEN_01 } from "./golden01";
import type { SectorWorkItem } from "../domains/sector-work";

export interface SeededWorkItem {
  sectorKey: string;
  item: SectorWorkItem;
}

export const SEEDED_WORK_ITEMS: Record<string, SeededWorkItem[]> = {
  [GOLDEN_01.tenantA.id]: [
    {
      sectorKey: "LEGAL",
      item: {
        externalRef: "MAT-2026-LON-001",
        title: "High Court Commercial Injunction Proceedings",
        unit: "COMMERCIAL_LITIGATION",
        demandWindow: "TRIAL_PREP",
        jurisdiction: "EWHC",
        accountableReviewerId: "00000000-0000-4000-a000-000000000001",
        activeWindowStart: "2026-03-01T08:00:00Z",
        activeWindowEnd: "2026-03-31T18:00:00Z"
      }
    },
    {
      sectorKey: "LEGAL",
      item: {
        externalRef: "MAT-2026-LON-002",
        title: "Cross-Border FinTech M&A Closing",
        unit: "CORPORATE_MA",
        demandWindow: "CLOSING_TRANSACTION",
        jurisdiction: "EWHC",
        accountableReviewerId: "00000000-0000-4000-a000-000000000001",
        activeWindowStart: "2026-02-15T08:00:00Z",
        activeWindowEnd: "2026-03-15T22:00:00Z"
      }
    },
    // SYNTHETIC demo items so a tenant switched to a preview sector sees representative data.
    {
      sectorKey: "HEALTHCARE",
      item: {
        externalRef: "EPI-DEMO-001",
        title: "Synthetic Winter Pressure Admissions Surge",
        unit: "ACUTE_MEDICINE",
        demandWindow: "WINTER_PRESSURE",
        accountableReviewerId: "00000000-0000-4000-a000-000000000001",
        activeWindowStart: "2026-01-05T08:00:00Z",
        activeWindowEnd: "2026-02-27T20:00:00Z"
      }
    },
    {
      sectorKey: "SOFTWARE_IT",
      item: {
        externalRef: "DEL-DEMO-001",
        title: "Synthetic Platform Release Cutover",
        unit: "PLATFORM_SQUAD",
        demandWindow: "RELEASE_CUTOVER",
        accountableReviewerId: "00000000-0000-4000-a000-000000000001",
        activeWindowStart: "2026-03-02T08:00:00Z",
        activeWindowEnd: "2026-03-13T18:00:00Z"
      }
    }
  ],
  [GOLDEN_01.tenantB.id]: [
    {
      sectorKey: "LEGAL",
      item: {
        externalRef: "MAT-2026-ARB-009",
        title: "London Maritime LCIA Multi-Jurisdictional Arbitration",
        unit: "ARBITRATION",
        demandWindow: "TRIAL",
        jurisdiction: "LCIA_ARBITRATION",
        accountableReviewerId: "00000000-0000-4000-b000-000000000001",
        activeWindowStart: "2026-03-01T09:00:00Z",
        activeWindowEnd: "2026-03-25T17:00:00Z"
      }
    }
  ]
};

export function listSeededWorkItems(tenantId: string, sectorKey: string): SectorWorkItem[] {
  return (SEEDED_WORK_ITEMS[tenantId] ?? []).filter(s => s.sectorKey === sectorKey).map(s => s.item);
}
