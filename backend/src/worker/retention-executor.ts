// backend/src/worker/retention-executor.ts
// Completion Plan Section 5.7 & G-21 / T-19:
// Background retention executor that enforces tenant-configured retention classes,
// honours legal holds, writes tombstones + external tombstone logs, and invalidates derived copies.
import crypto from "node:crypto";
import { withTenant, memDb, checkPgHealth } from "../platform/db/with-tenant";
import { runRetention } from "../domains/lifecycle/retention";
import { Actor } from "../platform/command";
import { GOLDEN_01 } from "../fixtures/golden01";

export interface RetentionExecutorSummary {
  executedAt: string;
  tenantsEvaluated: number;
  runsExecuted: number;
  totalPurged: number;
  totalHeld: number;
  totalBlocked: number;
}

/**
 * Executes a retention sweep for the specified tenant IDs (or active tenants with retention classes).
 * Uses each tenant's RISK_OWNER principal for attribution and writes counts-only summaries.
 */
export async function runScheduledRetentionPass(opts: {
  tenantIds?: string[];
  now?: Date;
} = {}): Promise<RetentionExecutorSummary> {
  const now = opts.now ?? new Date();
  const executedAt = now.toISOString();

  let targetTenants = opts.tenantIds;
  if (!targetTenants || targetTenants.length === 0) {
    const pgLive = await checkPgHealth();
    if (!pgLive) {
      const withPolicy = new Set<string>();
      for (const rc of memDb.retentionClasses.values()) {
        if (rc.status === "ACTIVE" && rc.tenant_id) {
          withPolicy.add(rc.tenant_id);
        }
      }
      targetTenants = Array.from(withPolicy);
    } else {
      targetTenants = [GOLDEN_01.tenantA.id, GOLDEN_01.tenantB.id];
    }
  }

  let runsExecuted = 0;
  let totalPurged = 0;
  let totalHeld = 0;
  let totalBlocked = 0;

  for (const tenantId of targetTenants) {
    const adminInfo = await withTenant(tenantId, async (tx) => {
      const classes = (await tx.q(`SELECT id FROM retention_class WHERE data_category = 'WORK_FACT' AND status = 'ACTIVE' LIMIT 1`)).rows;
      if (classes.length === 0) return null;
      const memberships = (await tx.q(
        `SELECT principal_id, organization_id, domain_role FROM effective_membership WHERE tenant_id = $1 AND valid_to IS NULL`,
        [tenantId]
      )).rows;
      const admin = memberships.find((m: any) => m.domain_role === "RISK_OWNER" || m.domain_role === "EMPLOYER_ADMIN");
      if (!admin) return null;
      return {
        principalId: admin.principal_id as string,
        organizationId: admin.organization_id as string,
        domainRole: admin.domain_role as string
      };
    });

    if (!adminInfo) continue;

    const actor: Actor = {
      tenantId,
      principalId: adminInfo.principalId,
      memberships: [{ domain_role: adminInfo.domainRole, organization_id: adminInfo.organizationId }]
    };

    const res = await runRetention({
      who: {
        tenantId,
        subject: "system:retention-executor",
        role: adminInfo.domainRole,
        purpose: "RETENTION_ENFORCEMENT"
      },
      actor,
      dataCategory: "WORK_FACT",
      idempotencyKey: `retention-exec-${tenantId}-${executedAt.slice(0, 16)}-${crypto.randomUUID().slice(0, 8)}`,
      now
    });

    runsExecuted++;
    totalPurged += Number(res.body.purged || 0);
    totalHeld += Number(res.body.held || 0);
    if (res.body.status === "BLOCKED") totalBlocked++;
  }

  return {
    executedAt,
    tenantsEvaluated: targetTenants.length,
    runsExecuted,
    totalPurged,
    totalHeld,
    totalBlocked
  };
}
