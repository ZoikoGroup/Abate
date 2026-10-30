// backend/src/domains/lifecycle/sector.ts
import { AppError } from "../../platform/errors";

export interface SectorMapping {
  sector: string;
  workItem: {
    fromEntity: (entity: any) => { kind: string; externalRef: string; unit: string };
  };
  demandWindows: string[];
  forbidden: string[];
  cannotOverride: string[];
}

/**
 * Legal Sector Pack Contract (Playbook B5 §3)
 * Maps matters, practice areas, phases, and trial/closing windows onto neutral core concepts.
 */
export const legalMapping: SectorMapping = {
  sector: "LEGAL",
  workItem: {
    fromEntity: (m: { matterId: string; practiceArea: string }) => ({
      kind: "WORK_ITEM",
      externalRef: m.matterId,
      unit: m.practiceArea
    })
  },
  demandWindows: ["TRIAL_PREP", "TRIAL", "CLOSING", "FILING_DEADLINE"],
  forbidden: ["substantiveWorkProduct", "clientConfidentialNotes"], // never ingested, per constitutional boundaries
  cannotOverride: ["privacyFloor", "aiAuthority"] // sector packs cannot lower these
};

/**
 * Accounting Sector Pack Fixture (Architecture test for portability)
 * Proves the engine is neutral across knowledge sectors without code forks.
 */
export const accountingMapping: SectorMapping = {
  sector: "ACCOUNTING",
  workItem: {
    fromEntity: (eng: { engagementId: string; serviceLine: string }) => ({
      kind: "WORK_ITEM",
      externalRef: eng.engagementId,
      unit: eng.serviceLine
    })
  },
  demandWindows: ["BUSY_SEASON", "AUDIT_CLOSE", "TAX_DEADLINE"],
  forbidden: ["substantiveWorkProduct", "clientTaxReturns"],
  cannotOverride: ["privacyFloor", "aiAuthority"]

};

/**
 * validateSectorPack: Ensures sector pack cannot lower privacy floor or expand AI authority.
 * PDF Page 4: "Sector pack tries to lower privacy floor or expand AI authority -> Rejected at load/validation time".
 */
export function validateSectorPack(content: any): void {
  if (content.privacyFloor !== undefined && content.privacyFloor < 10) {
    throw new AppError("VALIDATION", `Sector pack rejected: cannot lower privacyFloor (${content.privacyFloor}) below constitutional minimum (10).`);
  }
  if (content.aiAuthority !== undefined && content.aiAuthority === "EXPANDED") {
    throw new AppError("VALIDATION", "Sector pack rejected: cannot expand AI authority beyond human-in-the-loop governance.");
  }
}
