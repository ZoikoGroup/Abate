// backend/src/domains/sector-work/rule-engine.ts
// Pure, deterministic multi-rule sector evaluation engine & jurisdiction overlay resolver.
// Evaluates composable cohort-level work-design rules declared in any SectorPackDefinition
// without hardcoding sector branches or producing individual scores.

import { evaluateNeutralFatigueSurge } from "../lifecycle/sector";
import type {
  JurisdictionOverlay,
  RequiredGate,
  RuleCitationStatus,
  SectorMapping,
  SectorPackStatus,
  SectorRule
} from "../lifecycle/sector-pack";

export interface WorkIntervalUtc {
  startUtc: string;
  endUtc: string;
}

export interface SectorRuleFinding {
  ruleId: string;
  title: string;
  type: SectorRule["type"];
  triggered: boolean;
  observedValue: number;
  thresholdValue: number;
  unit: string;
  requiredGate: RequiredGate;
  citationStatus: RuleCitationStatus;
  reference: string;
  rationale: string;
}

export interface ResolvedJurisdictionOverlay {
  overlayKey: string | null;
  jurisdictionCode: string | null;
  overlayStatus: "APPROVED" | "PREVIEW_PLACEHOLDER" | "DRAFT" | "EXPIRED" | "UNBOUND";
  supportsComplianceClaim: boolean;
  accountableReviewer: string | null;
  reviewDate: string | null;
  statutoryReferences: string[];
  consultationGates: RequiredGate[];
  retentionNote: string;
}

export interface SectorRuleEvaluationReport {
  sectorKey: string;
  packStatus: SectorPackStatus;
  workItemId: string;
  unit: string;
  demandWindow: string;
  anyTriggered: boolean;
  triggeredRuleCount: number;
  highestGate: RequiredGate;
  rules: SectorRuleFinding[];
  jurisdictionOverlay: ResolvedJurisdictionOverlay;
}

const GATE_PRIORITY: Record<RequiredGate, number> = {
  APPROVAL: 1,
  REVIEW: 2,
  CONSULTATION: 3
};

function sortIntervals(intervals: WorkIntervalUtc[]): Array<{ startMs: number; endMs: number; startUtc: string; endUtc: string }> {
  return intervals
    .map((i) => ({
      startMs: Date.parse(i.startUtc),
      endMs: Date.parse(i.endUtc),
      startUtc: i.startUtc,
      endUtc: i.endUtc
    }))
    .filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Merges overlapping intervals so total hours / rest gaps are mathematically deterministic. */
function mergeIntervals(sorted: Array<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  if (sorted.length === 0) return [];
  const merged: Array<{ startMs: number; endMs: number }> = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.startMs <= last.endMs) {
      if (cur.endMs > last.endMs) last.endMs = cur.endMs;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function defaultRuleFromMapping(mapping: SectorMapping): SectorRule {
  return {
    ruleId: `${mapping.sector}_LATE_EVENING_DEFAULT`,
    title: `Consecutive Late-Evening Sessions (${mapping.vocabulary.demandWindow})`,
    type: "CONSECUTIVE_LATE_NIGHTS",
    highDemandWindows: mapping.fatigueRule.highDemandWindows,
    consecutiveLateNights: mapping.fatigueRule.consecutiveLateNights,
    lateEveningUtcHour: mapping.fatigueRule.lateEveningUtcHour,
    earlyMorningUtcHour: mapping.fatigueRule.earlyMorningUtcHour,
    requiredGate: "CONSULTATION",
    citationStatus: mapping.status === "LAUNCHED" ? "APPROVED" : "PREVIEW_PLACEHOLDER",
    reference: mapping.fatigueNotice.surgeReference,
    rationale: mapping.fatigueNotice.surgeNotice
  };
}

function evaluateSingleRule(
  rule: SectorRule,
  item: { workItemId: string; unit: string; demandWindow: string },
  intervals: WorkIntervalUtc[]
): SectorRuleFinding {
  const sorted = sortIntervals(intervals);
  const merged = mergeIntervals(sorted);

  switch (rule.type) {
    case "CONSECUTIVE_LATE_NIGHTS": {
      const res = evaluateNeutralFatigueSurge(item, intervals, {
        highDemandWindows: rule.highDemandWindows,
        consecutiveLateNights: rule.consecutiveLateNights,
        lateEveningUtcHour: rule.lateEveningUtcHour,
        earlyMorningUtcHour: rule.earlyMorningUtcHour
      });
      return {
        ruleId: rule.ruleId,
        title: rule.title,
        type: rule.type,
        triggered: res.hasFatigueSurge,
        observedValue: res.consecutiveLateNightsCount,
        thresholdValue: rule.consecutiveLateNights,
        unit: "consecutive_nights",
        requiredGate: rule.requiredGate,
        citationStatus: rule.citationStatus,
        reference: rule.reference,
        rationale: rule.rationale
      };
    }

    case "MIN_INTER_SHIFT_REST": {
      const windowMatches = !rule.appliesToWindows || rule.appliesToWindows.length === 0 || rule.appliesToWindows.includes(item.demandWindow);
      let shortRestTransitions = 0;
      for (let i = 1; i < merged.length; i++) {
        const gapHours = (merged[i].startMs - merged[i - 1].endMs) / 3_600_000;
        if (gapHours < rule.minRestHours) {
          shortRestTransitions++;
        }
      }
      return {
        ruleId: rule.ruleId,
        title: rule.title,
        type: rule.type,
        triggered: windowMatches && shortRestTransitions > rule.maxShortRestTransitions,
        observedValue: shortRestTransitions,
        thresholdValue: rule.maxShortRestTransitions,
        unit: `transitions_under_${rule.minRestHours}h_rest`,
        requiredGate: rule.requiredGate,
        citationStatus: rule.citationStatus,
        reference: rule.reference,
        rationale: rule.rationale
      };
    }

    case "ROLLING_WEEKLY_HOURS_CAP": {
      const totalHours = merged.reduce((sum, m) => sum + (m.endMs - m.startMs) / 3_600_000, 0);
      let weeklyAvg = totalHours;
      if (merged.length > 0) {
        const spanDays = Math.max(7, Math.min(rule.windowDays, Math.ceil((merged[merged.length - 1].endMs - merged[0].startMs) / 86_400_000)));
        weeklyAvg = Math.round(((totalHours * 7) / spanDays) * 10) / 10;
      } else {
        weeklyAvg = 0;
      }
      return {
        ruleId: rule.ruleId,
        title: rule.title,
        type: rule.type,
        triggered: weeklyAvg > rule.maxWeeklyHours,
        observedValue: weeklyAvg,
        thresholdValue: rule.maxWeeklyHours,
        unit: "hours_per_week",
        requiredGate: rule.requiredGate,
        citationStatus: rule.citationStatus,
        reference: rule.reference,
        rationale: rule.rationale
      };
    }

    case "CONSECUTIVE_ON_CALL_OR_WEEKEND": {
      const windowMatches = !rule.appliesToWindows || rule.appliesToWindows.length === 0 || rule.appliesToWindows.includes(item.demandWindow);
      const weekendDays = new Set<string>();
      for (const m of merged) {
        const startDay = new Date(m.startMs);
        const endDay = new Date(m.endMs - 1);
        for (const d of [startDay, endDay]) {
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) {
            weekendDays.add(d.toISOString().slice(0, 10));
          }
        }
      }
      let maxGapHours = merged.length <= 1 ? rule.minUninterruptedRestHours : 0;
      for (let i = 1; i < merged.length; i++) {
        const gapHours = (merged[i].startMs - merged[i - 1].endMs) / 3_600_000;
        if (gapHours > maxGapHours) maxGapHours = gapHours;
      }
      const spanDays = merged.length > 1 ? (merged[merged.length - 1].endMs - merged[0].startMs) / 86_400_000 : 0;
      const missingWeeklyRest = spanDays >= 6 && maxGapHours < rule.minUninterruptedRestHours;
      const triggered = windowMatches && (weekendDays.size > rule.maxConsecutiveWeekendDays || missingWeeklyRest);
      return {
        ruleId: rule.ruleId,
        title: rule.title,
        type: rule.type,
        triggered,
        observedValue: weekendDays.size,
        thresholdValue: rule.maxConsecutiveWeekendDays,
        unit: "weekend_work_days",
        requiredGate: rule.requiredGate,
        citationStatus: rule.citationStatus,
        reference: rule.reference,
        rationale: rule.rationale
      };
    }

    case "HIGH_DEMAND_WINDOW_DURATION": {
      const inHighDemand = rule.highDemandWindows.includes(item.demandWindow);
      const spanDays =
        merged.length === 0
          ? 0
          : Math.max(1, Math.ceil((merged[merged.length - 1].endMs - merged[0].startMs) / 86_400_000));
      return {
        ruleId: rule.ruleId,
        title: rule.title,
        type: rule.type,
        triggered: inHighDemand && spanDays > rule.maxConsecutiveDays,
        observedValue: inHighDemand ? spanDays : 0,
        thresholdValue: rule.maxConsecutiveDays,
        unit: "days_in_high_demand_window",
        requiredGate: rule.requiredGate,
        citationStatus: rule.citationStatus,
        reference: rule.reference,
        rationale: rule.rationale
      };
    }
  }
}

/**
 * Resolves the effective jurisdiction overlay for a sector at timestamp `at`.
 * Fails closed: expired, draft, or preview overlays can NEVER support a compliance claim.
 */
export function resolveJurisdictionOverlay(
  mapping: SectorMapping,
  opts?: { jurisdictionCode?: string; at?: Date }
): ResolvedJurisdictionOverlay {
  const overlays = mapping.jurisdictionOverlays ?? [];
  if (overlays.length === 0) {
    return {
      overlayKey: null,
      jurisdictionCode: opts?.jurisdictionCode ?? null,
      overlayStatus: "UNBOUND",
      supportsComplianceClaim: false,
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: mapping.requiredGates,
      retentionNote: "No approved jurisdiction retention schedule bound; zero automated deletion until configured."
    };
  }

  const atMs = (opts?.at ?? new Date()).getTime();
  const candidates: JurisdictionOverlay[] = opts?.jurisdictionCode
    ? overlays.filter((o) => o.jurisdictionCode === opts.jurisdictionCode)
    : overlays;

  if (candidates.length === 0) {
    return {
      overlayKey: null,
      jurisdictionCode: opts?.jurisdictionCode ?? null,
      overlayStatus: "UNBOUND",
      supportsComplianceClaim: false,
      accountableReviewer: null,
      reviewDate: null,
      statutoryReferences: [],
      consultationGates: mapping.requiredGates,
      retentionNote: `No jurisdiction overlay configured for '${opts?.jurisdictionCode}'; fail-closed neutral baseline applies.`
    };
  }

  const active = candidates.find((o) => {
    const from = Date.parse(o.effectiveFrom);
    const to = o.effectiveTo ? Date.parse(o.effectiveTo) : Infinity;
    return from <= atMs && atMs < to;
  });

  if (!active) {
    const latest = candidates[candidates.length - 1];
    return {
      overlayKey: latest.overlayKey,
      jurisdictionCode: latest.jurisdictionCode,
      overlayStatus: "EXPIRED",
      supportsComplianceClaim: false,
      accountableReviewer: latest.accountableReviewer,
      reviewDate: latest.reviewDate,
      statutoryReferences: latest.statutoryReferences,
      consultationGates: latest.consultationGates,
      retentionNote: "Jurisdiction overlay expired at decision time; cannot support a new compliance claim."
    };
  }

  const supportsComplianceClaim =
    mapping.status === "LAUNCHED" &&
    active.approvalStatus === "APPROVED" &&
    Boolean(active.accountableReviewer) &&
    Boolean(active.reviewDate);

  return {
    overlayKey: active.overlayKey,
    jurisdictionCode: active.jurisdictionCode,
    overlayStatus: active.approvalStatus,
    supportsComplianceClaim,
    accountableReviewer: active.accountableReviewer,
    reviewDate: active.reviewDate,
    statutoryReferences: active.statutoryReferences,
    consultationGates: active.consultationGates,
    retentionNote: active.retentionNote
  };
}

/**
 * Evaluates all declared rules in a SectorMapping against minimized work intervals.
 */
export function evaluateSectorRules(
  mapping: SectorMapping,
  item: { workItemId: string; unit: string; demandWindow: string },
  intervals: WorkIntervalUtc[],
  opts?: { jurisdictionCode?: string; at?: Date }
): SectorRuleEvaluationReport {
  const activeRules = mapping.rules.length > 0 ? mapping.rules : [defaultRuleFromMapping(mapping)];
  const findings = activeRules.map((rule) => evaluateSingleRule(rule, item, intervals));
  const triggered = findings.filter((f) => f.triggered);
  let highestGate: RequiredGate = "APPROVAL";
  for (const f of triggered) {
    if (GATE_PRIORITY[f.requiredGate] > GATE_PRIORITY[highestGate]) {
      highestGate = f.requiredGate;
    }
  }
  const overlay = resolveJurisdictionOverlay(mapping, opts);
  return {
    sectorKey: mapping.sector,
    packStatus: mapping.status,
    workItemId: item.workItemId,
    unit: item.unit,
    demandWindow: item.demandWindow,
    anyTriggered: triggered.length > 0,
    triggeredRuleCount: triggered.length,
    highestGate,
    rules: findings,
    jurisdictionOverlay: overlay
  };
}
