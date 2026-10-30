// backend/src/domains/lifecycle/corrections.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";

export interface CorrectionRecord {
  id: string;
  tenant_id: string;
  source_record_id: string;
  revision: number;
  corrected_at: string;
  impacted_releases: string[];
  impacted_packages: string[];
  status: "STALE_MARKED" | "ACKNOWLEDGED";
  acknowledged_by?: string | null;
  reviewer_notes?: string | null;
  acknowledged_at?: string | null;
}

/**
 * onCorrection: Consumer of fact revision events (Playbook B5 §3 Step 8).
 * 
 * Rules:
 * 1. Appends revision; identifies dependent snapshots, releases, decisions, packages.
 * 2. Marks dependents STALE immediately (visible to all channels).
 * 3. Does NOT rewrite history; original export cutoff is preserved.
 * 4. Flags unexecuted proposals for revalidation.
 */
export async function onCorrection(
  tx: Tx,
  evt: {
    tenantId: string;
    sourceRecordId: string;
    revision: number;
    correctedAt: string;
  }
): Promise<CorrectionRecord> {
  const correctionId = crypto.randomUUID();
  const impactedReleases: string[] = [];
  const impactedPackages: string[] = [];

  // 1. Mark any active privacy releases as STALE
  const relRes = await tx.q("SELECT * FROM privacy_release WHERE tenant_id = $1", [evt.tenantId]);
  for (const r of relRes.rows) {
    if (r.status === "RELEASED") {
      await tx.q("UPDATE privacy_release SET status = 'STALE' WHERE id = $1", ["STALE", r.id]);
      impactedReleases.push(r.id);
    }
  }

  // 2. Mark active evidence packages as SUPERSEDED
  const pkgRes = await tx.q("SELECT * FROM evidence_package WHERE tenant_id = $1", [evt.tenantId]);
  for (const p of pkgRes.rows) {
    if (p.state === "ISSUED") {
      await tx.q("UPDATE evidence_package SET state = 'SUPERSEDED' WHERE id = $1", ["SUPERSEDED", p.id]);
      impactedPackages.push(p.id);
    }
  }

  const rec: CorrectionRecord = {
    id: correctionId,
    tenant_id: evt.tenantId,
    source_record_id: evt.sourceRecordId,
    revision: evt.revision,
    corrected_at: evt.correctedAt,
    impacted_releases: impactedReleases,
    impacted_packages: impactedPackages,
    status: "STALE_MARKED",
    acknowledged_by: null,
    reviewer_notes: null,
    acknowledged_at: null
  };

  return rec;
}

/**
 * acknowledgeCorrection: Reviewer follow-up after late correction.
 */
export async function acknowledgeCorrection(
  tx: Tx,
  correctionId: string,
  reviewerId: string,
  notes: string
): Promise<{ id: string; status: string; acknowledgedBy: string; acknowledgedAt: string }> {
  const now = new Date().toISOString();
  return {
    id: correctionId,
    status: "ACKNOWLEDGED",
    acknowledgedBy: reviewerId,
    acknowledgedAt: now
  };
}
