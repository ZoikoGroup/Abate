// backend/src/domains/performance/flags.ts
// Feature flag management for Phase 7 (outcomes_plane_b disabled by default)
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { FeatureFlagView } from "../../contracts/outcomes";

export const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = {
  outcomes_plane_b: false,
  ai_change_assessment: false
};

/**
 * isFeatureFlagEnabled: Evaluates flag for tenant; falls back to platform default (false).
 */
export async function isFeatureFlagEnabled(
  tx: Tx,
  tenantId: string,
  flag: string
): Promise<boolean> {
  const res = await tx.q(
    `SELECT enabled FROM feature_flag 
     WHERE (tenant_id = $1 OR tenant_id IS NULL) AND flag = $2
     ORDER BY tenant_id NULLS LAST LIMIT 1`,
    [tenantId, flag]
  );
  if (res.rowCount && res.rowCount > 0) {
    return Boolean(res.rows[0].enabled);
  }
  return DEFAULT_FEATURE_FLAGS[flag] ?? false;
}

/**
 * requireFeatureFlag: Throws UNAVAILABLE / FORBIDDEN if the feature flag is disabled.
 */
export async function requireFeatureFlag(
  tx: Tx,
  tenantId: string,
  flag: string
): Promise<void> {
  const enabled = await isFeatureFlagEnabled(tx, tenantId, flag);
  if (!enabled) {
    throw new AppError(
      "FORBIDDEN",
      `Feature '${flag}' is disabled. Work-design outcomes and AI change assessment are not enabled for this tenant.`
    );
  }
}

/**
 * setFeatureFlag: Sets or toggles flag for a tenant or platform.
 */
export async function setFeatureFlag(
  tx: Tx,
  flag: string,
  enabled: boolean,
  changedBy: string,
  tenantId?: string
): Promise<FeatureFlagView> {
  const targetTenantId = tenantId || null;
  const now = new Date().toISOString();
  await tx.q(
    `INSERT INTO feature_flag (tenant_id, flag, enabled, changed_by, changed_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, flag) DO UPDATE
     SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [targetTenantId, flag, enabled, changedBy, now]
  );

  return {
    flag,
    enabled,
    tenantId: targetTenantId,
    changedBy,
    changedAt: now
  };
}

/**
 * listFeatureFlags: Lists active feature flags for tenant.
 */
export async function listFeatureFlags(
  tx: Tx,
  tenantId: string
): Promise<FeatureFlagView[]> {
  const res = await tx.q(
    `SELECT flag, enabled, tenant_id, changed_by, changed_at FROM feature_flag
     WHERE tenant_id = $1 OR tenant_id IS NULL`,
    [tenantId]
  );
  return res.rows.map((r: any) => ({
    flag: r.flag,
    enabled: Boolean(r.enabled),
    tenantId: r.tenant_id,
    changedBy: r.changed_by,
    changedAt: r.changed_at
  }));
}
