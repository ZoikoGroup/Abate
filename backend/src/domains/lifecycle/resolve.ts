// backend/src/domains/lifecycle/resolve.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { PolicyResolution, PackRef, DecisionEnvelopeView } from "../../contracts/governance";
import { canonicalJson, sha256Hex } from "../../platform/canonical";
import { getDefaultEntitlements, featureAllowed } from "./entitlement";

export interface PolicyPackRecord {
  id: string;
  pack_key: string;
  version: number;
  kind: "JURISDICTION" | "SECTOR" | "CUSTOMER";
  effective_from: string | Date;
  effective_to: string | Date | null;
  status: "DRAFT" | "APPROVED" | "WITHDRAWN";
  source_refs: any;
  accountable_reviewer: string;
  review_date: string;
  content: any;
  content_hash: string;
}

export interface TenantBindingRecord {
  tenant_id: string;
  pack_key: string;
  pack_version: number;
  applies_to: {
    customerEntity?: string;
    locations?: string[];
    sector?: string;
    feature?: string[];
  };
  bound_from: string | Date;
  bound_to: string | Date | null;
}

const ms = (d: string | Date) => new Date(d).getTime();

export async function activeBindings(
  tx: Tx,
  tenantId: string,
  at: Date
): Promise<TenantBindingRecord[]> {
  const t = at.getTime();
  const res = await tx.q("SELECT * FROM tenant_policy_binding WHERE tenant_id = $1", [tenantId]);
  return res.rows.filter((b: any) => {
    const from = ms(b.bound_from);
    const to = b.bound_to ? ms(b.bound_to) : Infinity;
    return from <= t && t < to;
  });
}

export async function approvedPackAt(
  tx: Tx,
  packKey: string,
  at: Date
): Promise<PolicyPackRecord | null> {
  const t = at.getTime();
  const res = await tx.q("SELECT * FROM policy_pack WHERE pack_key = $1 AND status = 'APPROVED'", [packKey]);
  const covering = res.rows
    .filter((p: any) => ms(p.effective_from) <= t && (p.effective_to === null || t < ms(p.effective_to)))
    .sort((a: any, b: any) => b.version - a.version);
  return covering[0] || null;
}

function appliesToFeature(pack: PolicyPackRecord, appliesTo: TenantBindingRecord["applies_to"], feature: string): boolean {
  if (!appliesTo.feature || appliesTo.feature.length === 0) return true;
  return appliesTo.feature.includes(feature) || appliesTo.feature.includes("*");
}

function detectConflicts(applied: PackRef[]): string[] {
  const keys = new Set<string>();
  const conflicts: string[] = [];
  for (const p of applied) {
    if (keys.has(p.key)) {
      conflicts.push(`Duplicate active version conflict for pack key ${p.key}`);
    }
    keys.add(p.key);
  }
  return conflicts;
}

function deriveGates(applied: PackRef[]): Array<"APPROVAL" | "CONSULTATION" | "REVIEW"> {
  const gates: Array<"APPROVAL" | "CONSULTATION" | "REVIEW"> = ["APPROVAL"];
  // If sector or customer packs are applied, derive consultation and review needs
  if (applied.some(p => p.key.includes("sector") || p.key.includes("legal") || p.key.includes("bar"))) {
    gates.push("CONSULTATION", "REVIEW");
  }
  return gates;
}

/**
 * resolvePolicy: Pure deterministic resolution of applicable packs and gates (Playbook B5 §2).
 * Answers: Given this tenant, this feature and this moment, which approved pack versions apply?
 * Records exactly what was used into the decision envelope.
 */
export async function resolvePolicy(
  tx: Tx,
  q: { tenantId: string; feature: string; at: Date }
): Promise<PolicyResolution> {
  const bindings = await activeBindings(tx, q.tenantId, q.at);
  const applied: PackRef[] = [];
  const restricted: string[] = [];

  for (const b of bindings) {
    const pack = await approvedPackAt(tx, b.pack_key, q.at);
    if (!pack) {
      // Pack expired or withdrawn at this instant: affected functions restricted
      restricted.push(b.pack_key);
      continue;
    }
    if (!appliesToFeature(pack, b.applies_to, q.feature)) {
      continue;
    }
    applied.push({
      key: pack.pack_key,
      version: pack.version,
      hash: pack.content_hash
    });
  }

  const conflicts = detectConflicts(applied);
  const requiredGates = deriveGates(applied);

  return {
    applied,
    restricted,
    conflicts,
    requiredGates,
    ambiguous: conflicts.length > 0
  };
}

/**
 * recordDecisionEnvelope: Persists decision resolution with every material decision.
 * Enables historical reconstruction: decisions made last year remain explainable
 * under last year's pack versions.
 */
export async function recordDecisionEnvelope(
  tx: Tx,
  envelope: {
    decisionType: string;
    resourceId: string;
    resolution: PolicyResolution;
    metricVersions?: Record<string, number>;
    privacyProfile?: string;
    sectorPack?: string;
    modelPromptVersions?: Record<string, string>;
  }
): Promise<DecisionEnvelopeView> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await tx.q(
    `INSERT INTO decision_envelope (
      id, tenant_id, decision_type, resource_id, resolved_at, resolution,
      metric_versions, privacy_profile, sector_pack, model_prompt_versions
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      tx.tenantId,
      envelope.decisionType,
      envelope.resourceId,
      now,
      envelope.resolution,
      envelope.metricVersions || null,
      envelope.privacyProfile || null,
      envelope.sectorPack || null,
      envelope.modelPromptVersions || null
    ]
  );

  return {
    id,
    tenantId: tx.tenantId,
    decisionType: envelope.decisionType,
    resourceId: envelope.resourceId,
    resolvedAt: now,
    resolution: envelope.resolution,
    metricVersions: envelope.metricVersions,
    privacyProfile: envelope.privacyProfile,
    sectorPack: envelope.sectorPack,
    modelPromptVersions: envelope.modelPromptVersions
  };
}

export async function getDecisionEnvelope(
  tx: Tx,
  resourceId: string
): Promise<DecisionEnvelopeView | null> {
  const res = await tx.q(
    "SELECT * FROM decision_envelope WHERE resource_id = $1 AND tenant_id = $2 ORDER BY resolved_at DESC LIMIT 1",
    [resourceId, tx.tenantId]
  );
  if (!res.rowCount || res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    decisionType: row.decision_type,
    resourceId: row.resource_id,
    resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : new Date(row.resolved_at).toISOString(),
    resolution: typeof row.resolution === "string" ? JSON.parse(row.resolution) : row.resolution,
    metricVersions: row.metric_versions ? (typeof row.metric_versions === "string" ? JSON.parse(row.metric_versions) : row.metric_versions) : undefined,
    privacyProfile: row.privacy_profile,
    sectorPack: row.sector_pack,
    modelPromptVersions: row.model_prompt_versions ? (typeof row.model_prompt_versions === "string" ? JSON.parse(row.model_prompt_versions) : row.model_prompt_versions) : undefined
  };
}

export async function canTenantFeature(
  tx: Tx,
  args: { feature: string; at: Date }
): Promise<{
  allowed: boolean;
  reason?: string;
  commercial: any;
  policy: PolicyResolution;
}> {
  const ent = getDefaultEntitlements(tx.tenantId);
  const pol = await resolvePolicy(tx, { tenantId: tx.tenantId, feature: args.feature, at: args.at });
  const com = featureAllowed(args.feature, ent, pol);
  return {
    allowed: com.allowed,
    reason: com.reason,
    commercial: com,
    policy: pol
  };
}
