// backend/src/domains/ai/kill-switch.ts
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";

export interface KillSwitchRecord {
  scope: string;
  active: boolean;
  changed_by: string | null;
  changed_at: string;
}

export async function getKillSwitches(tx: Tx): Promise<KillSwitchRecord[]> {
  const res = await tx.q("SELECT * FROM ai_kill_switch");
  return res.rows;
}

export async function isKillSwitchActive(tx: Tx, scope: string): Promise<boolean> {
  const res = await tx.q("SELECT active FROM ai_kill_switch WHERE scope = $1", [scope]);
  if (!res.rowCount || res.rowCount === 0) return false;
  return Boolean(res.rows[0].active);
}

export async function assertNoKillSwitch(tx: Tx, scopes: string[]): Promise<void> {
  // Always check global switch 'all_ai' first
  const allScopes = Array.from(new Set([...scopes, "all_ai"]));
  for (const s of allScopes) {
    if (await isKillSwitchActive(tx, s)) {
      throw new AppError("UNAVAILABLE", `AI assistance is disabled by kill switch (${s}). You can continue manually.`);
    }
  }
}

export async function setKillSwitch(
  tx: Tx,
  scope: string,
  active: boolean,
  changedBy: string
): Promise<KillSwitchRecord> {
  const now = new Date().toISOString();
  await tx.q(
    `INSERT INTO ai_kill_switch (scope, active, changed_by, changed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope) DO UPDATE SET active = EXCLUDED.active, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [scope, active, changedBy, now]
  );
  return {
    scope,
    active,
    changed_by: changedBy,
    changed_at: now
  };
}

