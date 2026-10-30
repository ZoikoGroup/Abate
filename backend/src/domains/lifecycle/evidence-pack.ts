// backend/src/domains/lifecycle/evidence-pack.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { EvidencePackageView } from "../../contracts/governance";
import { canonicalJson, sha256Hex } from "../../platform/canonical";

export interface StoredEvidenceItem {
  type: string;
  id: string;
  version: number;
  sha256: string;
  objectKey: string;
  data: any;
}

/**
 * In-memory simulated object store for content-addressed evidence bytes.
 * Key format: t/${tenantId}/evidence/${sha256}
 */
export const memoryObjectStore = new Map<string, string>();

/**
 * issuePackage: Issues a content-addressed, manifest-hashed, supersession-aware Evidence Package (Playbook B5 §3).
 * Gathers complete risk-control vertical slice evidence with zero raw workforce telemetry.
 */
export async function issuePackage(
  tx: Tx,
  args: {
    hazardId: string;
    classification?: "RESTRICTED" | "CONFIDENTIAL" | "PUBLIC";
    issuerPrincipalId: string;
    supersedesId?: string | null;
  }
): Promise<EvidencePackageView> {
  const cutoff = new Date().toISOString();
  const classification = args.classification || "RESTRICTED";
  const items: StoredEvidenceItem[] = [];

  // 1. Hazard
  const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [args.hazardId, tx.tenantId]);
  if (!hRes.rowCount || hRes.rowCount === 0) {
    throw new AppError("NOT_FOUND", "Hazard not found for evidence packaging.");
  }
  const hazard = hRes.rows[0];
  const hazardBytes = canonicalJson(hazard);
  const hazardSha = sha256Hex(hazardBytes);
  const hazardKey = `t/${tx.tenantId}/evidence/${hazardSha}`;
  memoryObjectStore.set(hazardKey, hazardBytes);
  items.push({
    type: "hazard",
    id: hazard.id,
    version: hazard.version,
    sha256: hazardSha,
    objectKey: hazardKey,
    data: hazard
  });

  // 2. Causes
  const cRes = await tx.q("SELECT * FROM cause WHERE hazard_id = $1 AND tenant_id = $2", [hazard.id, tx.tenantId]);
  for (const c of cRes.rows) {
    const bytes = canonicalJson(c);
    const sha = sha256Hex(bytes);
    const key = `t/${tx.tenantId}/evidence/${sha}`;
    memoryObjectStore.set(key, bytes);
    items.push({ type: "cause", id: c.id, version: c.version, sha256: sha, objectKey: key, data: c });
  }

  // 3. Interventions
  const iRes = await tx.q("SELECT * FROM intervention WHERE hazard_id = $1 AND tenant_id = $2", [hazard.id, tx.tenantId]);
  for (const i of iRes.rows) {
    const bytes = canonicalJson(i);
    const sha = sha256Hex(bytes);
    const key = `t/${tx.tenantId}/evidence/${sha}`;
    memoryObjectStore.set(key, bytes);
    items.push({ type: "intervention", id: i.id, version: i.version, sha256: sha, objectKey: key, data: i });

    // Approvals for this intervention
    const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const a of aRes.rows) {
      const aBytes = canonicalJson(a);
      const aSha = sha256Hex(aBytes);
      const aKey = `t/${tx.tenantId}/evidence/${aSha}`;
      memoryObjectStore.set(aKey, aBytes);
      items.push({ type: "approval", id: a.id, version: a.approved_version, sha256: aSha, objectKey: aKey, data: a });
    }

    // Implementation receipts
    const rRes = await tx.q("SELECT * FROM implementation_receipt WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const r of rRes.rows) {
      const rBytes = canonicalJson(r);
      const rSha = sha256Hex(rBytes);
      const rKey = `t/${tx.tenantId}/evidence/${rSha}`;
      memoryObjectStore.set(rKey, rBytes);
      items.push({ type: "implementation_receipt", id: r.id, version: r.intervention_version, sha256: rSha, objectKey: rKey, data: r });
    }

    // Evaluations
    const eRes = await tx.q("SELECT * FROM evaluation WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const e of eRes.rows) {
      const eBytes = canonicalJson(e);
      const eSha = sha256Hex(eBytes);
      const eKey = `t/${tx.tenantId}/evidence/${eSha}`;
      memoryObjectStore.set(eKey, eBytes);
      items.push({ type: "evaluation", id: e.id, version: 1, sha256: eSha, objectKey: eKey, data: e });
    }
  }

  // 4. Released Artifact (asserts release is valid and not stale/withdrawn)
  if (hazard.originating_release_id) {
    const relRes = await tx.q(
      "SELECT * FROM released_artifact WHERE release_id = $1 AND tenant_id = $2",
      [hazard.originating_release_id, tx.tenantId]
    );
    if (relRes.rowCount && relRes.rowCount > 0) {
      const rel = relRes.rows[0];
      const relBytes = canonicalJson(rel);
      const relSha = sha256Hex(relBytes);
      const relKey = `t/${tx.tenantId}/evidence/${relSha}`;
      memoryObjectStore.set(relKey, relBytes);
      items.push({ type: "released_artifact", id: rel.release_id, version: rel.metric_version, sha256: relSha, objectKey: relKey, data: rel });
    }
  }

  // 5. Construct Canonical Manifest
  const manifestItems = items.map(it => ({
    type: it.type,
    id: it.id,
    version: it.version,
    sha256: it.sha256
  }));

  const manifest = {
    schema: "abate.evidence.v1",
    cutoff,
    issuer: args.issuerPrincipalId,
    classification,
    items: manifestItems
  };

  const manifestBytes = canonicalJson(manifest);
  const manifestHash = sha256Hex(manifestBytes);

  const packageId = crypto.randomUUID();
  const now = new Date().toISOString();

  // 6. Handle Supersession if provided
  if (args.supersedesId) {
    const prevRes = await tx.q("SELECT * FROM evidence_package WHERE id = $1 AND tenant_id = $2", [args.supersedesId, tx.tenantId]);
    if (prevRes.rowCount && prevRes.rowCount > 0) {
      await tx.q(
        "UPDATE evidence_package SET state = 'SUPERSEDED', superseded_by_id = $1 WHERE id = $2",
        [packageId, args.supersedesId]
      );
    }
  }

  // 7. Persist Package and Items
  await tx.q(
    `INSERT INTO evidence_package (
      id, tenant_id, scope, cutoff, issuer_principal_id, classification,
      manifest_hash, supersedes_id, superseded_by_id, state, issued_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ISSUED', $10)`,
    [
      packageId,
      tx.tenantId,
      { hazardId: hazard.id, title: hazard.title },
      cutoff,
      args.issuerPrincipalId,
      classification,
      manifestHash,
      args.supersedesId || null,
      null,
      now
    ]
  );

  for (const it of items) {
    await tx.q(
      `INSERT INTO evidence_item (
        package_id, item_type, item_id, item_version, sha256, object_key
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [packageId, it.type, it.id, it.version, it.sha256, it.objectKey]
    );
  }

  return {
    id: packageId,
    tenantId: tx.tenantId,
    scope: { hazardId: hazard.id, title: hazard.title },
    cutoff,
    issuerPrincipalId: args.issuerPrincipalId,
    classification,
    manifestHash,
    supersedesId: args.supersedesId || null,
    supersededById: null,
    state: "ISSUED",
    issuedAt: now,
    itemsCount: items.length,
    items: items.map(it => ({
      itemType: it.type,
      itemId: it.id,
      itemVersion: it.version,
      sha256: it.sha256,
      objectKey: it.objectKey
    }))
  };
}

export async function getEvidencePackage(
  tx: Tx,
  packageId: string
): Promise<EvidencePackageView | null> {
  const pkgRes = await tx.q("SELECT * FROM evidence_package WHERE id = $1 AND tenant_id = $2", [packageId, tx.tenantId]);
  if (!pkgRes.rowCount || pkgRes.rowCount === 0) return null;
  const p = pkgRes.rows[0];

  const itemsRes = await tx.q("SELECT * FROM evidence_item WHERE package_id = $1", [packageId]);

  return {
    id: p.id,
    tenantId: p.tenant_id,
    scope: typeof p.scope === "string" ? JSON.parse(p.scope) : p.scope,
    cutoff: typeof p.cutoff === "string" ? p.cutoff : new Date(p.cutoff).toISOString(),
    issuerPrincipalId: p.issuer_principal_id,
    classification: p.classification,
    manifestHash: p.manifest_hash,
    supersedesId: p.supersedes_id,
    supersededById: p.superseded_by_id,
    state: p.state,
    issuedAt: typeof p.issued_at === "string" ? p.issued_at : new Date(p.issued_at).toISOString(),
    itemsCount: itemsRes.rowCount || 0,
    items: itemsRes.rows.map((r: any) => ({
      itemType: r.item_type,
      itemId: r.item_id,
      itemVersion: r.item_version,
      sha256: r.sha256,
      objectKey: r.object_key
    }))
  };
}
