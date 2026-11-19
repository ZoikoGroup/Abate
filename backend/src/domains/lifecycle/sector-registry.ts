// backend/src/domains/lifecycle/sector-registry.ts
// Registry of sector packs. Adding a sector means adding one validated definition file and
// registering it here. No resolver, endpoint or database change is needed.
import { AppError } from "../../platform/errors";
import {
  CORE_FORBIDDEN_FIELDS,
  FatigueNotice,
  SectorMapping,
  SectorUiCopy,
  SectorPackDefinition,
  parseSectorPackDefinition
} from "./sector-pack";
import { genericPack } from "./packs/generic";
import { legalPack } from "./packs/legal";
import { accountingPack } from "./packs/accounting";
import { healthcarePack } from "./packs/healthcare";
import { softwareItPack } from "./packs/software-it";

export const BASELINE_SECTOR_KEY = "GENERIC";

export interface AvailableSector {
  sectorKey: string;
  packKey: string;
  displayName: string;
  status: SectorPackDefinition["status"];
}

const definitions = new Map<string, SectorPackDefinition>();
const mappings = new Map<string, SectorMapping>();

/** Neutral wording used when a pack authors none. It cites only the sector-neutral ISO 45003 baseline. */
function defaultFatigueNotice(def: SectorPackDefinition): FatigueNotice {
  const n = def.fatigueRule.consecutiveLateNights;
  return {
    surgeGateLabel: "CONSULTATION",
    standardGateLabel: "APPROVAL",
    surgeReference: "ISO 45003:2021 §6.1.2.1 (sector-neutral baseline reference)",
    baselineReference: "Neutral baseline practice",
    surgeNotice: `SURGE ALERT: ${n}+ consecutive late-night work sessions detected during a high-demand ${def.vocabulary.demandWindow.toLowerCase()}. Closing this hazard requires ${def.vocabulary.supervisor} consultation and workload re-balancing.`,
    baselineNotice: "Within acceptable boundary variance. Normal risk governance applies."
  };
}

/** Default screen wording, built from the pack vocabulary. Packs override only what differs. */
function defaultUiCopy(def: SectorPackDefinition): SectorUiCopy {
  const v = def.vocabulary;
  const n = def.fatigueRule.consecutiveLateNights;
  const hour = String(def.fatigueRule.lateEveningUtcHour).padStart(2, "0");
  const heading = `${def.displayName}: ${v.workItems} & ${v.demandWindow}`;
  const subtitle = `Sector work-design review for ${v.workItems.toLowerCase()}. Detects unbuffered late-evening work during high-demand windows and requires ${v.supervisor} consultation.`;
  return {
    navLabel: def.displayName,
    sectorBadge: `SECTOR: ${def.displayName.toUpperCase()}`,
    badges: ["ISO 45003 §6.1.2.1"],
    heading,
    subtitle,
    panelTitle: heading,
    panelDescription: subtitle,
    mandatoryNote: `Mandatory: ${v.supervisor} consultation required prior to hazard disposition closure.`,
    boundaryTitle: "Constitutional Boundary Protection",
    boundaryText: "Physical minimization is active: zero substantive work product, confidential notes, or individual productivity scores enter persistence. Only neutral work cadence metadata is ingested.",
    listTitle: `${v.workItems} & Demand Windows`,
    unitFilterLabel: `Filter ${v.unit}`,
    allUnitsLabel: "All",
    unitLabels: {},
    fatigueButtonLabel: "Fatigue Check",
    fatigueCardTitle: "Workplace Fatigue Audit",
    surgeBadge: "SURGE ALERT: FATIGUE DETECTED",
    compliantBadge: "COMPLIANT: NORMAL VARIANCE",
    thresholdNote: `Threshold: ≥ ${n} consecutive nights with work past ${hour}:00 UTC during a high-demand window triggers mandatory ${v.supervisor} consultation.`,
    consultationTitle: `Mandatory ${v.supervisor} Consultation Gate`,
    consultationSignerLabel: v.supervisor,
    consultationSignerDefault: "",
    consultationActions: [
      { value: "REALLOCATE_CAPACITY", label: "Reallocate capacity to buffer late-evening work" },
      { value: "EXTEND_DEADLINE", label: "Seek a deadline buffer" },
      { value: "PROTECTED_REST_PERIOD", label: "Impose a protected rest period" }
    ],
    decoyFields: [
      { field: "individualScore", label: "Inject Individual Productivity Score", value: 1 },
      { field: "substantiveWorkProduct", label: "Inject Substantive Work Product", value: "Confidential working notes." }
    ]
  };
}

function buildMapping(def: SectorPackDefinition, launchedNames: string): SectorMapping {
  const pick = (entity: Record<string, unknown>, keys: string[], fallback?: string): string => {
    for (const k of keys) {
      const v = entity?.[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return fallback as string;
  };
  return {
    sector: def.sectorKey,
    packKey: def.packKey,
    vocabulary: { ...def.vocabulary },
    workItemUnits: [...(def.workItemUnits ?? [])],
    jurisdictions: [...(def.jurisdictions ?? [])],
    fatigueNotice: { ...(def.fatigueNotice ?? defaultFatigueNotice(def)) },
    ui: { ...defaultUiCopy(def), ...(def.ui ?? {}) } as SectorUiCopy,
    workItem: {
      fromEntity: (entity: any) => ({
        kind: "WORK_ITEM",
        externalRef: pick(entity, def.workItemFields.externalRef, def.workItemFallbacks?.externalRef),
        unit: pick(entity, def.workItemFields.unit, def.workItemFallbacks?.unit)
      })
    },
    demandWindows: [...def.demandWindows],
    highDemandWindows: [...def.highDemandWindows],
    fatigueRule: { ...def.fatigueRule, highDemandWindows: [...def.fatigueRule.highDemandWindows] },
    // Core forbidden fields are inherited by every pack and cannot be dropped.
    forbidden: Array.from(new Set([...CORE_FORBIDDEN_FIELDS, ...def.forbidden])),
    requiredGates: [...def.requiredGates],
    claimScope: def.claimScope.replace("{{launchedPacks}}", launchedNames),
    cannotOverride: ["privacyFloor", "aiAuthority"]
  };
}

function launchedPackNames(): string {
  const names = Array.from(definitions.values()).filter(d => d.status === "LAUNCHED").map(d => d.displayName);
  return names.length > 0 ? names.join(", ") : "none";
}

function rebuildMappings(): void {
  mappings.clear();
  const launched = launchedPackNames();
  for (const def of definitions.values()) {
    mappings.set(def.sectorKey, buildMapping(def, launched));
  }
}

/**
 * Validates and registers a sector pack. Throws on a duplicate sector or pack key, on a pack key already
 * accepted by another sector, and on any definition that breaks the constitutional floor.
 */
export function registerSectorPack(input: unknown): SectorMapping {
  const def = parseSectorPackDefinition(input);
  if (definitions.has(def.sectorKey)) {
    throw new AppError("VALIDATION", `Sector pack '${def.sectorKey}' is already registered.`);
  }
  for (const other of definitions.values()) {
    const clash = def.acceptedPackKeys.find(k => other.acceptedPackKeys.includes(k));
    if (clash) {
      throw new AppError("VALIDATION", `Sector pack '${def.sectorKey}' rejected: pack key '${clash}' already belongs to '${other.sectorKey}'.`);
    }
  }
  if (def.status === "BASELINE" && Array.from(definitions.values()).some(d => d.status === "BASELINE")) {
    throw new AppError("VALIDATION", "Only one BASELINE sector pack may be registered.");
  }
  definitions.set(def.sectorKey, def);
  rebuildMappings();
  return mappings.get(def.sectorKey) as SectorMapping;
}

// Built-ins. Order matters: it is the binding-detection priority (Legal first, fixtures last).
registerSectorPack(genericPack);
registerSectorPack(legalPack);
registerSectorPack(healthcarePack);
registerSectorPack(softwareItPack);
registerSectorPack(accountingPack);

export function getSectorMapping(sectorKey: string): SectorMapping | undefined {
  return mappings.get(sectorKey);
}

export function getBaselineMapping(): SectorMapping {
  return mappings.get(BASELINE_SECTOR_KEY) as SectorMapping;
}

export function isKnownSectorKey(sectorKey: string): boolean {
  return mappings.has(sectorKey);
}

export function listAvailableSectors(): AvailableSector[] {
  return Array.from(definitions.values()).map(d => ({
    sectorKey: d.sectorKey,
    packKey: d.packKey,
    displayName: d.displayName,
    status: d.status
  }));
}

export function getSectorDisplayName(sectorKey: string): string {
  return definitions.get(sectorKey)?.displayName ?? sectorKey;
}

/** Tags of LAUNCHED packs, reported to clients as the sectors enabled today. */
export function listEnabledSectorTags(): string[] {
  return Array.from(definitions.values()).filter(d => d.status === "LAUNCHED" && d.launchTag).map(d => d.launchTag as string);
}

/**
 * One-sentence statement of which sector packs are launched and which are previews pending review.
 * Used where the product states its scope, so a preview pack is never described as launched.
 */
export function describeSectorScope(): string {
  const names = (status: SectorPackDefinition["status"]) =>
    Array.from(definitions.values()).filter(d => d.status === status).map(d => d.displayName);
  const launched = names("LAUNCHED");
  const preview = names("PREVIEW");
  const parts = [`Sector-neutral core with launched sector packs: ${launched.length > 0 ? launched.join(", ") : "none"}`];
  if (preview.length > 0) parts.push(`preview packs pending policy review: ${preview.join(", ")}`);
  return parts.join("; ");
}

/** Throws unless the sector is registered and the pack key is one that sector accepts. */
export function assertValidSectorSelection(sectorKey: string, packKey: string): void {
  const def = definitions.get(sectorKey);
  if (!def) {
    const known = Array.from(definitions.keys()).join(", ");
    throw new AppError("VALIDATION", `Unknown sector '${sectorKey}'. Registered sectors: ${known}.`);
  }
  if (!def.acceptedPackKeys.includes(packKey)) {
    throw new AppError("VALIDATION", `Pack '${packKey}' does not belong to sector '${sectorKey}'. Accepted: ${def.acceptedPackKeys.join(", ")}.`);
  }
}

function keyWords(key: string): string[] {
  return key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Picks a sector from the tenant's active policy bindings, in registration order.
 * Matching is by whole word, so "legal-uk-sra" matches "legal" but "debarment" does not match "bar".
 */
export function detectSectorByBindings(activePackKeys: string[]): SectorMapping | undefined {
  for (const def of definitions.values()) {
    if (def.bindingMatchers.length === 0) continue;
    const hit = activePackKeys.some(k => {
      const words = keyWords(k);
      return def.bindingMatchers.some(m => words.includes(m));
    });
    if (hit) return mappings.get(def.sectorKey);
  }
  return undefined;
}
