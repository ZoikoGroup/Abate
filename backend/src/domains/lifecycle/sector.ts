// backend/src/domains/lifecycle/sector.ts
import { AppError } from "../../platform/errors";
import { Tx } from "../../platform/db/with-tenant";

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

export interface SectorMapping {
  sector: string;
  packKey: string;
  vocabulary: SectorVocabulary;
  workItem: {
    fromEntity: (entity: any) => { kind: string; externalRef: string; unit: string };
  };
  demandWindows: string[];
  highDemandWindows: string[];
  fatigueRule: NeutralFatigueRule;
  forbidden: string[];
  requiredGates: Array<"APPROVAL" | "CONSULTATION" | "REVIEW">;
  claimScope: string;
  cannotOverride: ["privacyFloor", "aiAuthority"];
}

export const GENERIC_VOCABULARY: SectorVocabulary = {
  workItem: "Work Item",
  workItems: "Work Items",
  unit: "Unit / Team",
  demandWindow: "Demand Window",
  supervisor: "Accountable Reviewer"
};

export const LEGAL_VOCABULARY: SectorVocabulary = {
  workItem: "Matter",
  workItems: "Matters",
  unit: "Practice Area",
  demandWindow: "Trial / Closing Window",
  supervisor: "Supervisory Partner"
};

export const ACCOUNTING_VOCABULARY: SectorVocabulary = {
  workItem: "Engagement",
  workItems: "Engagements",
  unit: "Service Line",
  demandWindow: "Busy Season / Close Window",
  supervisor: "Engagement Reviewer"
};

export const DEFAULT_NEUTRAL_FATIGUE_RULE: NeutralFatigueRule = {
  highDemandWindows: ["PEAK_PERIOD", "HIGH_DEMAND", "DEADLINE_WINDOW"],
  consecutiveLateNights: 3,
  lateEveningUtcHour: 20,
  earlyMorningUtcHour: 6
};

/**
 * Neutral Sector-Agnostic Core Profile.
 * Supplies baseline neutral vocabulary and configurable consecutive late-evening fatigue rule.
 */
export const genericMapping: SectorMapping = {
  sector: "GENERIC",
  packKey: "generic-work-design",
  vocabulary: GENERIC_VOCABULARY,
  workItem: {
    fromEntity: (w: { workItemId?: string; externalRef?: string; unit?: string }) => ({
      kind: "WORK_ITEM",
      externalRef: w.workItemId || w.externalRef || "WORK-ITEM-UNKNOWN",
      unit: w.unit || "GENERAL_TEAM"
    })
  },
  demandWindows: ["BASELINE", "PEAK_PERIOD", "HIGH_DEMAND", "DEADLINE_WINDOW"],
  highDemandWindows: ["PEAK_PERIOD", "HIGH_DEMAND", "DEADLINE_WINDOW"],
  fatigueRule: DEFAULT_NEUTRAL_FATIGUE_RULE,
  forbidden: ["substantiveWorkProduct", "clientConfidentialNotes", "individualScore", "keystrokeLogs"],
  requiredGates: ["APPROVAL"],
  claimScope: "Neutral work-design core active (no sector-specific overlay bound). Enabled packs today: UK Legal Sector Pack (SRA 2023).",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};

/**
 * Legal Sector Pack Contract (Playbook B5 §3)
 * Maps matters, practice areas, phases, and trial/closing windows onto neutral core concepts.
 */
export const legalMapping: SectorMapping = {
  sector: "LEGAL",
  packKey: "legal-uk-sra",
  vocabulary: LEGAL_VOCABULARY,
  workItem: {
    fromEntity: (m: { matterId: string; practiceArea: string }) => ({
      kind: "WORK_ITEM",
      externalRef: m.matterId,
      unit: m.practiceArea
    })
  },
  demandWindows: ["TRIAL_PREP", "TRIAL", "CLOSING", "CLOSING_TRANSACTION", "FILING_DEADLINE"],
  highDemandWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
  fatigueRule: {
    highDemandWindows: ["TRIAL_PREP", "CLOSING_TRANSACTION"],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 20,
    earlyMorningUtcHour: 6
  },
  forbidden: ["substantiveWorkProduct", "clientConfidentialNotes"], // never ingested, per constitutional boundaries
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "UK Legal Sector Pack (SRA 2023) active for this tenant.",
  cannotOverride: ["privacyFloor", "aiAuthority"] // sector packs cannot lower these
};

/**
 * Accounting Sector Pack Fixture (Architecture test for portability)
 * Proves the engine is neutral across knowledge sectors without code forks.
 */
export const accountingMapping: SectorMapping = {
  sector: "ACCOUNTING",
  packKey: "accounting-fixture",
  vocabulary: ACCOUNTING_VOCABULARY,
  workItem: {
    fromEntity: (eng: { engagementId: string; serviceLine: string }) => ({
      kind: "WORK_ITEM",
      externalRef: eng.engagementId,
      unit: eng.serviceLine
    })
  },
  demandWindows: ["BUSY_SEASON", "AUDIT_CLOSE", "TAX_DEADLINE"],
  highDemandWindows: ["BUSY_SEASON", "AUDIT_CLOSE"],
  fatigueRule: {
    highDemandWindows: ["BUSY_SEASON", "AUDIT_CLOSE"],
    consecutiveLateNights: 3,
    lateEveningUtcHour: 20,
    earlyMorningUtcHour: 6
  },
  forbidden: ["substantiveWorkProduct", "clientTaxReturns"],
  requiredGates: ["APPROVAL", "CONSULTATION", "REVIEW"],
  claimScope: "Portability test fixture only (Accounting is not a launched commercial pack).",
  cannotOverride: ["privacyFloor", "aiAuthority"]
};

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
  sectorKey: "GENERIC" | "LEGAL" | "ACCOUNTING";
  hasLegalPack: boolean;
  activePacks: string[];
  vocabulary: SectorVocabulary;
  demandWindows: string[];
  claimScope: string;
  enabledSectors: string[];
}

export async function setTenantSectorSetting(
  tx: Tx,
  args: { tenantId: string; sectorKey: "GENERIC" | "LEGAL" | "ACCOUNTING"; packKey: string; updatedBy?: string | null }
): Promise<void> {
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

  let selected: SectorMapping;
  if (explicitSetting?.sector_key === "LEGAL") {
    selected = legalMapping;
  } else if (explicitSetting?.sector_key === "ACCOUNTING") {
    selected = accountingMapping;
  } else if (explicitSetting?.sector_key === "GENERIC") {
    selected = genericMapping;
  } else {
    const hasLegalPackByBinding = activePacks.some(k => k.includes("legal") || k.includes("bar"));
    const isAccountingFixture = !hasLegalPackByBinding && activePacks.some(k => k.includes("accounting"));
    selected = hasLegalPackByBinding ? legalMapping : (isAccountingFixture ? accountingMapping : genericMapping);
  }

  const hasLegalPack = selected.sector === "LEGAL";

  return {
    tenantId,
    sectorKey: selected.sector as "GENERIC" | "LEGAL" | "ACCOUNTING",
    hasLegalPack,
    activePacks,
    vocabulary: selected.vocabulary,
    demandWindows: selected.demandWindows,
    claimScope: selected.claimScope,
    enabledSectors: ["LEGAL_UK"]
  };
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
