// backend/src/domains/control/evidence.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { stableStringify } from "./material";

export interface EvidenceItem {
  type: string;
  id: string;
  version: number;
  sha256: string;
  data: any;
}

export interface EvidenceManifest {
  packageId: string;
  hazardId: string;
  tenantId: string;
  cutoff: string;
  issuer: string;
  classification: "RESTRICTED" | "CONFIDENTIAL";
  items: Array<{
    type: string;
    id: string;
    version: number;
    sha256: string;
  }>;
  manifestHash: string;
}

export interface EvidencePackage {
  manifest: EvidenceManifest;
  artifacts: EvidenceItem[];
}

/**
 * exportEvidencePackage: Gathers complete risk-control vertical slice evidence (Playbook B4 §7).
 * Allows an outsider or auditor to independently verify the chain of accountability
 * without ever requiring access to raw workforce data.
 */
export async function exportEvidencePackage(
  tx: Tx,
  hazardId: string,
  issuer: string
): Promise<EvidencePackage> {
  const packageId = crypto.randomUUID();
  const cutoff = new Date().toISOString();
  const artifacts: EvidenceItem[] = [];

  // 1. Hazard
  const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [hazardId, tx.tenantId]);
  if (!hRes.rowCount || hRes.rowCount === 0) {
    throw new Error("Hazard not found");
  }
  const hazard = hRes.rows[0];
  const hStr = stableStringify(hazard);
  artifacts.push({
    type: "hazard",
    id: hazard.id,
    version: hazard.version,
    sha256: crypto.createHash("sha256").update(hStr).digest("hex"),
    data: hazard
  });

  // 2. Causes
  const cRes = await tx.q("SELECT * FROM cause WHERE hazard_id = $1 AND tenant_id = $2", [hazardId, tx.tenantId]);
  for (const c of cRes.rows) {
    const cStr = stableStringify(c);
    artifacts.push({
      type: "cause",
      id: c.id,
      version: c.version,
      sha256: crypto.createHash("sha256").update(cStr).digest("hex"),
      data: c
    });
  }

  // 3. Interventions (Controls)
  const iRes = await tx.q("SELECT * FROM intervention WHERE hazard_id = $1 AND tenant_id = $2", [hazardId, tx.tenantId]);
  for (const i of iRes.rows) {
    const iStr = stableStringify(i);
    artifacts.push({
      type: "intervention",
      id: i.id,
      version: i.version,
      sha256: crypto.createHash("sha256").update(iStr).digest("hex"),
      data: i
    });

    // 4. Approvals for this intervention
    const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const a of aRes.rows) {
      const aStr = stableStringify(a);
      artifacts.push({
        type: "approval",
        id: a.id,
        version: a.approved_version,
        sha256: crypto.createHash("sha256").update(aStr).digest("hex"),
        data: a
      });
    }

    // 5. Implementation Receipts
    const rRes = await tx.q("SELECT * FROM implementation_receipt WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const r of rRes.rows) {
      const rStr = stableStringify(r);
      artifacts.push({
        type: "implementation_receipt",
        id: r.id,
        version: r.intervention_version,
        sha256: crypto.createHash("sha256").update(rStr).digest("hex"),
        data: r
      });
    }

    // 6. Evaluations
    const eRes = await tx.q("SELECT * FROM evaluation WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const e of eRes.rows) {
      const eStr = stableStringify(e);
      artifacts.push({
        type: "evaluation",
        id: e.id,
        version: 1,
        sha256: crypto.createHash("sha256").update(eStr).digest("hex"),
        data: e
      });
    }
  }

  // 7. Originating Release
  const relRes = await tx.q("SELECT * FROM released_artifact WHERE release_id = $1 AND tenant_id = $2", [hazard.originating_release_id, tx.tenantId]);
  if (relRes.rowCount && relRes.rowCount > 0) {
    const rel = relRes.rows[0];
    const relStr = stableStringify(rel);
    artifacts.push({
      type: "released_artifact",
      id: rel.release_id,
      version: rel.metric_version,
      sha256: crypto.createHash("sha256").update(relStr).digest("hex"),
      data: rel
    });
  }

  // Build Manifest
  const manifestItems = artifacts.map((a) => ({
    type: a.type,
    id: a.id,
    version: a.version,
    sha256: a.sha256
  }));

  const manifestBase = {
    packageId,
    hazardId,
    tenantId: tx.tenantId,
    cutoff,
    issuer,
    classification: "RESTRICTED" as const,
    items: manifestItems
  };

  const manifestHash = crypto
    .createHash("sha256")
    .update(stableStringify(manifestBase))
    .digest("hex");

  return {
    manifest: {
      ...manifestBase,
      manifestHash
    },
    artifacts
  };
}

