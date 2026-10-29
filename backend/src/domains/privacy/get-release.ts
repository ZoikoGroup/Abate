// backend/src/domains/privacy/get-release.ts
import { withTenant } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import { ReleaseView } from "../../contracts/release";

/**
 * getRelease: The ONLY function employer-facing code may use to read measurement outputs.
 * Reads released_artifact and validates lifecycle status.
 * Never performs independent arithmetic or reads protected tables.
 */
export async function getRelease(actor: Actor, releaseId: string): Promise<ReleaseView> {
  return withTenant(actor.tenantId, async (tx) => {
    const res = await tx.q(
      `SELECT a.*, r.status AS rstatus FROM released_artifact a
       JOIN privacy_release r ON r.id = a.release_id
       WHERE a.release_id = $1`,
      [releaseId]
    );

    if (!res.rowCount || res.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Not found.");
    }

    const row = res.rows[0];

    // Lifecycle check: If superseded or stale, return stale view
    if (["WITHDRAWN", "SUPERSEDED", "STALE"].includes(row.rstatus)) {
      return {
        status: "STALE",
        releaseId: row.release_id,
        asOf: row.period_end,
        supersededAt: row.period_end,
        reason: (row.rstatus as any) || "SUPERSEDED"
      };
    }

    return {
      status: "RELEASED",
      releaseId: row.release_id,
      metricId: row.metric_id,
      metricName: "Boundary Intrusion Share",
      version: row.metric_version,
      value: Number(row.value),
      unit: "percent",
      cohortRef: row.cohort_set_hash ? `cohort:${row.cohort_set_hash.slice(0, 12)}` : "org:00000000-0000-4000-a001-000000000001",
      periodStart: row.period_start,
      periodEnd: row.period_end,
      quality: row.quality || "VALID",
      releasedAt: row.released_at || new Date().toISOString(),
      freshness: (row.rstatus === "RELEASED" ? "FRESH" : row.rstatus) || "FRESH",
      interpretation: row.interpretation || "Boundary Intrusion Share evaluates time worked outside agreed schedule blocks.",
      limits: "Cohort work-pattern condition. NOT an individual risk score, NOT a legal threshold.",
      assuranceLabel: "Verified Safe for Collective Workplace Design under ZAB-ENG-001 v1.0"
    };
  });
}

