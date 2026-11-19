// backend/src/domains/sector-work/index.ts
// Sector-neutral work-item handling. Every rule here is read from the active sector pack,
// so a new sector needs a pack definition and no change to this file.
import { z } from "zod";
import { AppError } from "../../platform/errors";
import { evaluateNeutralFatigueSurge } from "../lifecycle/sector";
import type { SectorMapping } from "../lifecycle/sector-pack";

/** Fields rejected for every sector, on top of the pack's own forbidden list. */
export const UNIVERSAL_FORBIDDEN_FIELDS = ["individualScore", "keystrokeLogs", "substantiveWorkProduct"] as const;

export interface SectorWorkItem {
  externalRef: string;
  title: string;
  unit: string;
  demandWindow: string;
  jurisdiction?: string;
  accountableReviewerId: string;
  activeWindowStart: string;
  activeWindowEnd: string;
}

export interface NeutralWorkItem {
  kind: "WORK_ITEM";
  externalRef: string;
  unit: string;
  demandWindow: string;
  timing: { startUtc: string; endUtc: string };
}

export interface SectorFatigueAssessment {
  sectorKey: string;
  workItemId: string;
  unit: string;
  demandWindow: string;
  hasFatigueSurge: boolean;
  consecutiveLateNightsCount: number;
  thresholdUsed: number;
  statutoryReference: string;
  applicableGate: string;
  regulatoryNotice: string;
}

/**
 * Rejects any payload carrying a field the sector forbids. Runs before schema parsing so the caller
 * gets the constitutional message instead of a generic unknown-field error.
 */
export function assertSectorBoundaryCompliance(mapping: SectorMapping, payload: Record<string, unknown>): void {
  const forbidden = new Set<string>([...UNIVERSAL_FORBIDDEN_FIELDS, ...mapping.forbidden]);
  for (const field of forbidden) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new AppError(
        "VALIDATION",
        `Constitutional Boundary Violation: Field '${field}' is strictly prohibited. Sector-confidential content, billing data, and individual rankings cannot enter persistence.`
      );
    }
  }
}

/**
 * Builds the strict work-item schema for a sector. Unit, jurisdiction and demand window are checked
 * against the pack's lists. An empty list means that dimension is free-form.
 */
export function buildWorkItemSchema(mapping: SectorMapping) {
  const oneOf = (values: string[], label: string) =>
    z.string().min(1).max(128).refine(v => values.length === 0 || values.includes(v), {
      message: `${label} must be one of: ${values.join(", ")}`
    });
  return z.object({
    externalRef: z.string().min(1).max(64),
    title: z.string().min(1).max(128),
    unit: oneOf(mapping.workItemUnits, "unit"),
    demandWindow: z.string().refine(v => mapping.demandWindows.includes(v), {
      message: `demandWindow must be one of: ${mapping.demandWindows.join(", ")}`
    }),
    jurisdiction: oneOf(mapping.jurisdictions, "jurisdiction").optional(),
    accountableReviewerId: z.string().uuid(),
    activeWindowStart: z.string().datetime(),
    activeWindowEnd: z.string().datetime()
  }).strict().refine(i => Date.parse(i.activeWindowEnd) > Date.parse(i.activeWindowStart), {
    message: "activeWindowEnd must be after activeWindowStart"
  });
}

/** Validates a raw payload for the sector: boundary check first, then the strict schema. */
export function parseSectorWorkItem(mapping: SectorMapping, payload: unknown): SectorWorkItem {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("VALIDATION", "Request body must be a JSON object.");
  }
  assertSectorBoundaryCompliance(mapping, payload as Record<string, unknown>);
  return buildWorkItemSchema(mapping).parse(payload) as SectorWorkItem;
}

export function mapToNeutralWorkItem(item: SectorWorkItem): NeutralWorkItem {
  return {
    kind: "WORK_ITEM",
    externalRef: item.externalRef,
    unit: item.unit,
    demandWindow: item.demandWindow,
    timing: { startUtc: item.activeWindowStart, endUtc: item.activeWindowEnd }
  };
}

/** Evaluates late-evening fatigue for a work item using the pack's rule and pack-authored wording. */
export function evaluateSectorFatigue(
  mapping: SectorMapping,
  item: Pick<SectorWorkItem, "externalRef" | "unit" | "demandWindow">,
  intervals: Array<{ startUtc: string; endUtc: string }>
): SectorFatigueAssessment {
  const neutral = evaluateNeutralFatigueSurge(
    { workItemId: item.externalRef, unit: item.unit, demandWindow: item.demandWindow },
    intervals,
    mapping.fatigueRule
  );
  const n = mapping.fatigueNotice;
  const surge = neutral.hasFatigueSurge;
  return {
    sectorKey: mapping.sector,
    workItemId: item.externalRef,
    unit: item.unit,
    demandWindow: item.demandWindow,
    hasFatigueSurge: surge,
    consecutiveLateNightsCount: neutral.consecutiveLateNightsCount,
    thresholdUsed: neutral.thresholdUsed,
    statutoryReference: surge ? n.surgeReference : n.baselineReference,
    applicableGate: surge ? n.surgeGateLabel : n.standardGateLabel,
    regulatoryNotice: surge ? n.surgeNotice : n.baselineNotice
  };
}
