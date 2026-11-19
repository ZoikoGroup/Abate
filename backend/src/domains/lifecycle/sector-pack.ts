// backend/src/domains/lifecycle/sector-pack.ts
// Sector pack contract: the shape every sector (legal, accounting, healthcare, ...) must satisfy.
// A pack is DATA that maps a sector's vocabulary and demand windows onto the neutral work-design core.
// A pack may add vocabulary, windows, fatigue thresholds and forbidden fields.
// A pack can never lower the privacy floor, expand AI authority, or drop a core forbidden field.
import { z } from "zod";
import { AppError } from "../../platform/errors";

export interface SectorVocabulary {
  workItem: string;
  workItems: string;
  unit: string;
  demandWindow: string;
  supervisor: string;
}

export interface NeutralWorkItemInput {
  workItemId: string;
  unit: string;
  demandWindow: string;
}

export interface NeutralFatigueRule {
  highDemandWindows: string[];
  consecutiveLateNights: number;
  lateEveningUtcHour: number;
  earlyMorningUtcHour: number;
}

export interface NeutralFatigueResult {
  workItemId: string;
  unit: string;
  demandWindow: string;
  hasFatigueSurge: boolean;
  consecutiveLateNightsCount: number;
  thresholdUsed: number;
}

export type RequiredGate = "APPROVAL" | "CONSULTATION" | "REVIEW";

/** Screen wording for a sector. Every pack gets a full set; a pack authors only what differs from the default. */
export interface SectorUiCopy {
  navLabel: string;
  sectorBadge: string;
  badges: string[];
  heading: string;
  subtitle: string;
  panelTitle: string;
  panelDescription: string;
  mandatoryNote: string;
  boundaryTitle: string;
  boundaryText: string;
  listTitle: string;
  unitFilterLabel: string;
  allUnitsLabel: string;
  unitLabels: Record<string, string>;
  fatigueButtonLabel: string;
  fatigueCardTitle: string;
  surgeBadge: string;
  compliantBadge: string;
  thresholdNote: string;
  consultationTitle: string;
  consultationSignerLabel: string;
  consultationSignerDefault: string;
  consultationActions: Array<{ value: string; label: string }>;
  decoyFields: Array<{ field: string; label: string; value: string | number }>;
}

/** Wording and gate labels shown when a fatigue surge is, or is not, detected for a work item. */
export interface FatigueNotice {
  surgeGateLabel: string;
  standardGateLabel: string;
  surgeReference: string;
  baselineReference: string;
  surgeNotice: string;
  baselineNotice: string;
}

export interface SectorMapping {
  sector: string;
  packKey: string;
  vocabulary: SectorVocabulary;
  /** Allowed unit values. Empty means any unit string is accepted. */
  workItemUnits: string[];
  /** Allowed jurisdiction values. Empty means any jurisdiction string is accepted. */
  jurisdictions: string[];
  fatigueNotice: FatigueNotice;
  ui: SectorUiCopy;
  workItem: {
    fromEntity: (entity: any) => { kind: string; externalRef: string; unit: string };
  };
  demandWindows: string[];
  highDemandWindows: string[];
  fatigueRule: NeutralFatigueRule;
  forbidden: string[];
  requiredGates: RequiredGate[];
  claimScope: string;
  cannotOverride: ["privacyFloor", "aiAuthority"];
}

/** Constitutional floor: constants no sector pack may relax. */
export const PRIVACY_FLOOR_MINIMUM = 10;

/** Fields no sector may ever ingest. Every pack inherits these; a pack can only add more. */
export const CORE_FORBIDDEN_FIELDS: readonly string[] = [
  "substantiveWorkProduct",
  "individualScore",
  "keystrokeLogs"
];

export const DEFAULT_NEUTRAL_FATIGUE_RULE: NeutralFatigueRule = {
  highDemandWindows: ["PEAK_PERIOD", "HIGH_DEMAND", "DEADLINE_WINDOW"],
  consecutiveLateNights: 3,
  lateEveningUtcHour: 20,
  earlyMorningUtcHour: 6
};

export const SECTOR_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const PACK_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,119}$/;
const WINDOW_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * validateSectorPack: ensures a sector pack cannot lower the privacy floor or expand AI authority.
 * Playbook: "Sector pack tries to lower privacy floor or expand AI authority -> Rejected at load/validation time".
 */
export function validateSectorPack(content: any): void {
  if (content.privacyFloor !== undefined && content.privacyFloor < PRIVACY_FLOOR_MINIMUM) {
    throw new AppError("VALIDATION", `Sector pack rejected: cannot lower privacyFloor (${content.privacyFloor}) below constitutional minimum (${PRIVACY_FLOOR_MINIMUM}).`);
  }
  if (content.aiAuthority !== undefined && content.aiAuthority === "EXPANDED") {
    throw new AppError("VALIDATION", "Sector pack rejected: cannot expand AI authority beyond human-in-the-loop governance.");
  }
}

/**
 * BASELINE: the neutral core profile, always present, never matched by binding.
 * LAUNCHED: a commercial pack tenants may be onboarded on. Its regulatory content has been approved.
 * PREVIEW: a real sector pack whose regulatory content is pending policy review. Selectable, never claimed as launched.
 * FIXTURE: portability test pack, selectable but not claimed as launched.
 */
export type SectorPackStatus = "BASELINE" | "LAUNCHED" | "PREVIEW" | "FIXTURE";

const nonEmpty = z.string().trim().min(1).max(120);

const copy = z.string().trim().min(1).max(400);

const SectorUiCopySchema = z.object({
  navLabel: nonEmpty,
  sectorBadge: nonEmpty,
  badges: z.array(nonEmpty).max(4),
  heading: copy,
  subtitle: copy,
  panelTitle: copy,
  panelDescription: copy,
  mandatoryNote: copy,
  boundaryTitle: copy,
  boundaryText: copy,
  listTitle: copy,
  unitFilterLabel: nonEmpty,
  allUnitsLabel: nonEmpty,
  unitLabels: z.record(z.string(), nonEmpty),
  fatigueButtonLabel: nonEmpty,
  fatigueCardTitle: copy,
  surgeBadge: nonEmpty,
  compliantBadge: nonEmpty,
  thresholdNote: copy,
  consultationTitle: copy,
  consultationSignerLabel: nonEmpty,
  // Empty by default: the screen asks the user to type a name, so no pack ships a person's name.
  consultationSignerDefault: z.string().max(120),
  consultationActions: z.array(z.object({ value: z.string().regex(WINDOW_PATTERN), label: copy }).strict()).min(1).max(8),
  decoyFields: z.array(z.object({
    field: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,63}$/),
    label: copy,
    value: z.union([z.string().max(200), z.number()])
  }).strict()).min(1).max(8)
}).strict();

const FatigueRuleSchema = z.object({
  highDemandWindows: z.array(z.string().regex(WINDOW_PATTERN)).min(1),
  consecutiveLateNights: z.number().int().min(1).max(14),
  lateEveningUtcHour: z.number().int().min(0).max(23),
  earlyMorningUtcHour: z.number().int().min(0).max(23)
}).strict();

export const SectorPackDefinitionSchema = z.object({
  sectorKey: z.string().regex(SECTOR_KEY_PATTERN),
  packKey: z.string().regex(PACK_KEY_PATTERN),
  /** Pack keys a tenant may save for this sector. Must include packKey. */
  acceptedPackKeys: z.array(z.string().regex(PACK_KEY_PATTERN)).min(1),
  /** Lowercase words. A tenant policy binding whose key has one of these as a word selects this sector. */
  bindingMatchers: z.array(z.string().regex(/^[a-z0-9]+$/)),
  status: z.enum(["BASELINE", "LAUNCHED", "PREVIEW", "FIXTURE"]),
  displayName: nonEmpty,
  /** Short stable tag reported in enabledSectors. Required for LAUNCHED packs only. */
  launchTag: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/).optional(),
  vocabulary: z.object({
    workItem: nonEmpty,
    workItems: nonEmpty,
    unit: nonEmpty,
    demandWindow: nonEmpty,
    supervisor: nonEmpty
  }).strict(),
  /** Ordered entity field names that carry the external reference and unit in this sector's records. */
  workItemFields: z.object({
    externalRef: z.array(nonEmpty).min(1),
    unit: z.array(nonEmpty).min(1)
  }).strict(),
  workItemFallbacks: z.object({
    externalRef: nonEmpty.optional(),
    unit: nonEmpty.optional()
  }).strict().optional(),
  /** Allowed unit values for work items, for example service lines. Omit to accept any unit string. */
  workItemUnits: z.array(z.string().regex(WINDOW_PATTERN)).optional(),
  /** Allowed jurisdiction values. Omit to accept any jurisdiction string. */
  jurisdictions: z.array(nonEmpty).optional(),
  demandWindows: z.array(z.string().regex(WINDOW_PATTERN)).min(1),
  highDemandWindows: z.array(z.string().regex(WINDOW_PATTERN)),
  fatigueRule: FatigueRuleSchema,
  /** Screen wording overrides. Anything omitted falls back to a default built from the pack vocabulary. */
  ui: SectorUiCopySchema.partial().optional(),
  /** Pack-authored wording. Omit to use the neutral default built from the pack vocabulary. */
  fatigueNotice: z.object({
    surgeGateLabel: nonEmpty,
    standardGateLabel: nonEmpty,
    surgeReference: z.string().trim().min(1).max(300),
    baselineReference: z.string().trim().min(1).max(300),
    surgeNotice: z.string().trim().min(1).max(600),
    baselineNotice: z.string().trim().min(1).max(600)
  }).strict().optional(),
  /** Extra forbidden fields. Core forbidden fields are added automatically. */
  forbidden: z.array(nonEmpty),
  requiredGates: z.array(z.enum(["APPROVAL", "CONSULTATION", "REVIEW"])).min(1),
  /** May contain {{launchedPacks}}, replaced with the display names of LAUNCHED packs. */
  claimScope: nonEmpty.max(400),
  cannotOverride: z.tuple([z.literal("privacyFloor"), z.literal("aiAuthority")])
}).strict();

export type SectorPackDefinition = z.infer<typeof SectorPackDefinitionSchema>;

/** Validates a pack definition. Throws AppError VALIDATION with a precise reason. */
export function parseSectorPackDefinition(input: unknown): SectorPackDefinition {
  if (input && typeof input === "object") {
    validateSectorPack(input);
  }
  const parsed = SectorPackDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new AppError("VALIDATION", `Sector pack rejected: ${detail}`);
  }
  const def = parsed.data;
  const fail = (msg: string): never => {
    throw new AppError("VALIDATION", `Sector pack '${def.sectorKey}' rejected: ${msg}`);
  };
  if (!def.acceptedPackKeys.includes(def.packKey)) fail("acceptedPackKeys must include packKey.");
  if (def.status === "LAUNCHED" && !def.launchTag) fail("a LAUNCHED pack requires a launchTag.");
  if (def.status !== "LAUNCHED" && def.launchTag) fail("only a LAUNCHED pack may set a launchTag.");
  if (def.status === "BASELINE" && def.bindingMatchers.length > 0) fail("the BASELINE pack must not match bindings.");
  if (def.status !== "BASELINE" && def.bindingMatchers.length === 0) fail("a non-baseline pack needs at least one bindingMatcher.");
  const windows = new Set(def.demandWindows);
  if (windows.size !== def.demandWindows.length) fail("demandWindows must be unique.");
  for (const w of def.highDemandWindows) {
    if (!windows.has(w)) fail(`highDemandWindows entry '${w}' is not a declared demand window.`);
  }
  for (const key of Object.keys(def.ui?.unitLabels ?? {})) {
    if (def.workItemUnits && !def.workItemUnits.includes(key)) fail(`ui.unitLabels key '${key}' is not a declared work item unit.`);
  }
  for (const list of [def.workItemUnits ?? [], def.jurisdictions ?? []]) {
    if (new Set(list).size !== list.length) fail("workItemUnits and jurisdictions must not contain duplicates.");
  }
  for (const w of def.fatigueRule.highDemandWindows) {
    if (!windows.has(w)) fail(`fatigueRule window '${w}' is not a declared demand window.`);
  }
  return def;
}
