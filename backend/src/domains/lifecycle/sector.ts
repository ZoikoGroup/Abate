// backend/src/domains/lifecycle/sector.ts
// Sector resolution for a tenant. Sector knowledge lives in packs (see sector-registry.ts),
// not in this file. This file resolves which pack applies and exposes the neutral fatigue math.
import { AppError } from "../../platform/errors";
import { Tx } from "../../platform/db/with-tenant";
import {
  DEFAULT_NEUTRAL_FATIGUE_RULE,
  JurisdictionOverlay,
  NeutralFatigueResult,
  NeutralFatigueRule,
  NeutralWorkItemInput,
  SectorMapping,
  SectorPackStatus,
  SectorRule,
  SectorUiCopy,
  SectorVocabulary,
  validateSectorPack
} from "./sector-pack";
import {
  AvailableSector,
  assertValidSectorSelection,
  detectSectorByBindings,
  getBaselineMapping,
  getSectorDisplayName,
  getSectorMapping,
  listAvailableSectors,
  listEnabledSectorTags
} from "./sector-registry";
import { GENERIC_VOCABULARY } from "./packs/generic";
import { LEGAL_VOCABULARY } from "./packs/legal";
import { ACCOUNTING_VOCABULARY } from "./packs/accounting";
import { FINANCE_VOCABULARY } from "./packs/finance";

export type {
  JurisdictionOverlay,
  NeutralFatigueResult,
  NeutralFatigueRule,
  NeutralWorkItemInput,
  SectorMapping,
  SectorPackStatus,
  SectorRule,
  SectorUiCopy,
  SectorVocabulary,
  AvailableSector
};
export { DEFAULT_NEUTRAL_FATIGUE_RULE, GENERIC_VOCABULARY, LEGAL_VOCABULARY, ACCOUNTING_VOCABULARY, FINANCE_VOCABULARY, validateSectorPack };
export { registerSectorPack, getSectorMapping, listAvailableSectors, describeSectorScope } from "./sector-registry";

/** Built-in mappings, kept as named exports for existing callers. New code should use getSectorMapping. */
export const genericMapping: SectorMapping = getBaselineMapping();
export const legalMapping: SectorMapping = getSectorMapping("LEGAL") as SectorMapping;
export const accountingMapping: SectorMapping = getSectorMapping("ACCOUNTING") as SectorMapping;
export const financeMapping: SectorMapping = getSectorMapping("FINANCE") as SectorMapping;

/**
 * Sector-neutral consecutive late-evening fatigue rule.
 * Any pack supplies its demand windows and threshold while core timing math stays generic.
 */
export function evaluateNeutralFatigueSurge(
  item: NeutralWorkItemInput,
  intervals: Array<{ startUtc: string; endUtc: string }>,
  rule: NeutralFatigueRule = DEFAULT_NEUTRAL_FATIGUE_RULE
): NeutralFatigueResult {
  const sorted = [...intervals].sort((a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime());
  const daysWithLateWork = new Set<string>();

  for (const it of sorted) {
    const end = new Date(it.endUtc);
    const endHour = end.getUTCHours();
    if (endHour >= rule.lateEveningUtcHour || endHour < rule.earlyMorningUtcHour) {
      daysWithLateWork.add(end.toISOString().slice(0, 10));
    }
  }

  const sortedDays = Array.from(daysWithLateWork).sort();
  let maxConsecutive = 0;
  let currentConsecutive = 0;
  let prevDate: Date | null = null;

  for (const dayStr of sortedDays) {
    const curDate = new Date(dayStr);
    if (prevDate) {
      const diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / (24 * 3600 * 1000));
      currentConsecutive = diffDays === 1 ? currentConsecutive + 1 : 1;
    } else {
      currentConsecutive = 1;
    }
    prevDate = curDate;
    if (currentConsecutive > maxConsecutive) {
      maxConsecutive = currentConsecutive;
    }
  }

  const isHighDemand = rule.highDemandWindows.includes(item.demandWindow);
  return {
    workItemId: item.workItemId,
    unit: item.unit,
    demandWindow: item.demandWindow,
    hasFatigueSurge: isHighDemand && maxConsecutive >= rule.consecutiveLateNights,
    consecutiveLateNightsCount: maxConsecutive,
    thresholdUsed: rule.consecutiveLateNights
  };
}

export interface TenantSectorProfile {
  tenantId: string;
  /** Registered sector key, for example GENERIC, LEGAL or ACCOUNTING. */
  sectorKey: string;
  packKey: string;
  packStatus: SectorPackStatus;
  displayName: string;
  /** True when a sector pack other than the neutral baseline is active. */
  packActive: boolean;
  /** Deprecated: use sectorKey === "LEGAL". Kept for one release for existing clients. */
  hasLegalPack: boolean;
  activePacks: string[];
  vocabulary: SectorVocabulary;
  demandWindows: string[];
  highDemandWindows: string[];
  /** Allowed work item units for the sector. Empty means free-form. */
  workItemUnits: string[];
  /** Composable cohort work-design rules declared by the active pack. */
  rules: SectorRule[];
  /** Effective-dated jurisdiction overlays bound to this sector pack. */
  jurisdictionOverlays: JurisdictionOverlay[];
  /** Screen wording for the sector, so clients render any sector without sector-specific code. */
  ui: SectorUiCopy;
  claimScope: string;
  enabledSectors: string[];
  availableSectors: AvailableSector[];
}

export async function setTenantSectorSetting(
  tx: Tx,
  args: { tenantId: string; sectorKey: string; packKey: string; updatedBy?: string | null }
): Promise<void> {
  assertValidSectorSelection(args.sectorKey, args.packKey);
  await tx.q(
    `INSERT INTO tenant_sector_setting (tenant_id, sector_key, pack_key, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id)
     DO UPDATE SET sector_key = EXCLUDED.sector_key, pack_key = EXCLUDED.pack_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [args.tenantId, args.sectorKey, args.packKey, args.updatedBy ?? null]
  );
}

export async function resolveTenantSectorProfile(
  tx: Tx,
  tenantId: string,
  at: Date = new Date()
): Promise<TenantSectorProfile> {
  const nowMs = at.getTime();
  const settingRes = await tx.q("SELECT sector_key, pack_key FROM tenant_sector_setting WHERE tenant_id = $1", [tenantId]);
  const explicitSetting = settingRes.rows[0] as { sector_key?: string; pack_key?: string } | undefined;

  const bindRes = await tx.q("SELECT pack_key, bound_from, bound_to FROM tenant_policy_binding WHERE tenant_id = $1", [tenantId]);
  const activePacks = bindRes.rows
    .filter((b: any) => {
      const from = new Date(b.bound_from).getTime();
      const to = b.bound_to ? new Date(b.bound_to).getTime() : Infinity;
      return from <= nowMs && nowMs < to;
    })
    .map((b: any) => String(b.pack_key));

  const tenantRes = await tx.q("SELECT jurisdiction_config_ref FROM tenant WHERE id = $1", [tenantId]);
  const jurRef = String(tenantRes.rows[0]?.jurisdiction_config_ref || "");
  if (jurRef && !activePacks.includes(jurRef)) {
    activePacks.push(jurRef);
  }
  if (explicitSetting?.pack_key && !activePacks.includes(explicitSetting.pack_key)) {
    activePacks.push(explicitSetting.pack_key);
  }

  // An explicit tenant setting wins. A sector that is no longer registered fails closed to the
  // neutral baseline. With no setting, the sector is detected from the tenant's policy bindings.
  let selected: SectorMapping;
  if (explicitSetting?.sector_key) {
    selected = getSectorMapping(explicitSetting.sector_key) ?? getBaselineMapping();
  } else {
    selected = detectSectorByBindings(activePacks) ?? getBaselineMapping();
  }

  return {
    tenantId,
    sectorKey: selected.sector,
    packKey: selected.packKey,
    packStatus: selected.status,
    displayName: getSectorDisplayName(selected.sector),
    packActive: selected.sector !== getBaselineMapping().sector,
    hasLegalPack: selected.sector === "LEGAL",
    activePacks,
    vocabulary: selected.vocabulary,
    demandWindows: selected.demandWindows,
    highDemandWindows: selected.highDemandWindows,
    workItemUnits: selected.workItemUnits,
    rules: selected.rules,
    jurisdictionOverlays: selected.jurisdictionOverlays,
    ui: selected.ui,
    claimScope: selected.claimScope,
    enabledSectors: listEnabledSectorTags(),
    availableSectors: listAvailableSectors()
  };
}

/** Fails closed with 403 unless the tenant's active sector is the given one. */
export async function assertTenantHasSectorPack(
  tx: Tx,
  tenantId: string,
  sectorKey: string,
  at: Date = new Date()
): Promise<void> {
  const profile = await resolveTenantSectorProfile(tx, tenantId, at);
  if (profile.sectorKey !== sectorKey) {
    throw new AppError("FORBIDDEN", `${getSectorDisplayName(sectorKey)} is not enabled for this tenant.`);
  }
}

export async function assertTenantHasLegalPack(
  tx: Tx,
  tenantId: string,
  at: Date = new Date()
): Promise<void> {
  const profile = await resolveTenantSectorProfile(tx, tenantId, at);
  if (!profile.hasLegalPack) {
    throw new AppError("FORBIDDEN", "Legal Sector Pack is not enabled for this tenant.");
  }
}
