// backend/src/domains/privacy/get-release.ts
import { withTenant, Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import { ReleaseView } from "../../contracts/release";

/**
 * getRelease: The ONLY function employer-facing code may use to read measurement outputs.
 * Reads released_artifact and validates lifecycle status.
 * Never performs independent arithmetic or reads protected tables.
 */
export async function getRelease(actor: Actor, releaseId: string, expectedPlane?: "A" | "B"): Promise<ReleaseView> {
  return withTenant(actor.tenantId, (tx) => getReleaseTx(tx, releaseId, expectedPlane));
}

/**
 * Same read path on an already-open tenant transaction. Callers that hold a transaction MUST use this:
 * getRelease() opens a second pooled connection, and nested checkouts exhaust the pool under load
 * (each request pins two connections while waiting for a third).
 */
export async function getReleaseTx(tx: Tx, releaseId: string, expectedPlane?: "A" | "B"): Promise<ReleaseView> {
  {
    const res = await tx.q(
      `SELECT a.*, r.status AS rstatus, COALESCE(r.plane, a.plane, 'A') AS plane FROM released_artifact a
       JOIN privacy_release r ON r.id = a.release_id
       WHERE a.release_id = $1`,
      [releaseId]
    );

    if (!res.rowCount || res.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Not found.");
    }

    const row = res.rows[0];
    const plane: "A" | "B" = (row.plane as "A" | "B") || "A";

    if (expectedPlane && plane !== expectedPlane) {
      // Phase 7: The API refuses to return a Plane-B release from an assurance endpoint and vice versa.
      throw new AppError("NOT_FOUND", "Not found.");
    }

    // Lifecycle check: If superseded or stale, return stale view
    if (["WITHDRAWN", "SUPERSEDED", "STALE"].includes(row.rstatus)) {
      return {
        status: "STALE",
        releaseId: row.release_id,
        plane,
        asOf: row.period_end,
        supersededAt: row.period_end,
        reason: (row.rstatus as any) || "SUPERSEDED"
      };
    }

    return {
      status: "RELEASED",
      releaseId: row.release_id,
      plane,
      metricId: row.metric_id,
      metricName: row.metric_name || "Boundary Intrusion Share",
      version: row.metric_version,
      value: Number(row.value),
      unit: row.unit || "percent",
      cohortRef: row.cohort_set_hash ? `cohort:${row.cohort_set_hash.slice(0, 12)}` : "org:00000000-0000-4000-a001-000000000001",
      periodStart: row.period_start,
      periodEnd: row.period_end,
      quality: row.quality || "VALID",
      releasedAt: row.released_at || new Date().toISOString(),
      freshness: (row.rstatus === "RELEASED" ? "FRESH" : row.rstatus) || "FRESH",
      interpretation: row.interpretation || "Boundary Intrusion Share evaluates time worked outside agreed schedule blocks.",
      limits: "Cohort work-pattern condition. NOT an individual risk score, NOT a legal threshold.",
      assuranceLabel: plane === "B"
        ? "Work-Design Outcome (Plane B) - Not evidence that a hazard has been controlled"
        : "Verified Safe for Collective Workplace Design under ZAB-ENG-001 v1.0"
    };
  }
}
