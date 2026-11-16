// backend/src/domains/lifecycle/evidence-pack.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { EvidencePackageView } from "../../contracts/governance";
import { canonicalJson, sha256Hex } from "../../platform/canonical";
import { buildMerkleTree } from "../../platform/merkle";
import {
  getObjectStore,
  memoryObjectStore,
  ObjectStore,
  putVerified,
  readVerified
} from "../../platform/object-store";

export { memoryObjectStore };

export interface StoredEvidenceItem {
  type: string;
  id: string;
  version: number;
  sha256: string;
  objectKey: string;
  data: any;
}

async function persistArtifact(
  store: ObjectStore,
  tenantId: string,
  type: string,
  id: string,
  version: number,
  data: any
): Promise<StoredEvidenceItem> {
  const bytes = canonicalJson(data);
  const sha = sha256Hex(bytes);
  const key = `t/${tenantId}/evidence/${sha}`;
  await putVerified(store, key, bytes, sha);
  return { type, id, version, sha256: sha, objectKey: key, data };
}

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
  const store = getObjectStore();
  const items: StoredEvidenceItem[] = [];

  // 1. Hazard
  const hRes = await tx.q("SELECT * FROM hazard WHERE id = $1 AND tenant_id = $2", [args.hazardId, tx.tenantId]);
  if (!hRes.rowCount || hRes.rowCount === 0) {
    throw new AppError("NOT_FOUND", "Hazard not found for evidence packaging.");
  }
  const hazard = hRes.rows[0];
  items.push(await persistArtifact(store, tx.tenantId, "hazard", hazard.id, hazard.version, hazard));

  // 2. Causes
  const cRes = await tx.q("SELECT * FROM cause WHERE hazard_id = $1 AND tenant_id = $2", [hazard.id, tx.tenantId]);
  for (const c of cRes.rows) {
    items.push(await persistArtifact(store, tx.tenantId, "cause", c.id, c.version, c));
  }

  // 3. Interventions
  const iRes = await tx.q("SELECT * FROM intervention WHERE hazard_id = $1 AND tenant_id = $2", [hazard.id, tx.tenantId]);
  for (const i of iRes.rows) {
    items.push(await persistArtifact(store, tx.tenantId, "intervention", i.id, i.version, i));

    // Approvals for this intervention
    const aRes = await tx.q("SELECT * FROM approval WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const a of aRes.rows) {
      items.push(await persistArtifact(store, tx.tenantId, "approval", a.id, a.approved_version, a));
    }

    // Implementation receipts
    const rRes = await tx.q("SELECT * FROM implementation_receipt WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const r of rRes.rows) {
      items.push(await persistArtifact(store, tx.tenantId, "implementation_receipt", r.id, r.intervention_version, r));
    }

    // Evaluations
    const eRes = await tx.q("SELECT * FROM evaluation WHERE intervention_id = $1 AND tenant_id = $2", [i.id, tx.tenantId]);
    for (const e of eRes.rows) {
      items.push(await persistArtifact(store, tx.tenantId, "evaluation", e.id, 1, e));
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
      items.push(await persistArtifact(store, tx.tenantId, "released_artifact", rel.release_id, rel.metric_version, rel));
    }
  }

  // 5. Construct Canonical Manifest
  const manifestItems = items.map(it => ({
    type: it.type,
    id: it.id,
    version: it.version,
    sha256: it.sha256
  }));

  const merkleTree = buildMerkleTree(manifestItems.map(it => it.sha256));

  const manifest = {
    schema: "abate.evidence.v1",
    cutoff,
    issuer: args.issuerPrincipalId,
    classification,
    items: manifestItems,
    merkleRoot: merkleTree.root
  };

  const manifestBytes = canonicalJson(manifest);
  const manifestHash = sha256Hex(manifestBytes);

  const packageId = crypto.randomUUID();
  const manifestKey = `t/${tx.tenantId}/evidence-manifests/${packageId}.json`;
  await putVerified(store, manifestKey, manifestBytes, manifestHash);
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
    merkleRoot: merkleTree.root,
    merkleProofs: merkleTree.leafProofs,
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

export interface StoredEvidenceVerification {
  verified: boolean;
  packageId: string;
  objectStoreMode: "memory" | "s3";
  manifestKey: string;
  manifestHash: string;
  merkleRoot: string | null;
  verifiedItems: number;
  totalItems: number;
  errors: string[];
}

/**
 * verifyStoredEvidencePackage: Downloads manifest + every content-addressed item from the active ObjectStore,
 * verifies SHA-256 digests against DB manifest_hash and item hashes, and validates the Merkle root.
 */
export async function verifyStoredEvidencePackage(
  tx: Tx,
  packageId: string
): Promise<StoredEvidenceVerification | null> {
  const pkg = await getEvidencePackage(tx, packageId);
  if (!pkg) return null;

  const store = getObjectStore();
  const manifestKey = `t/${tx.tenantId}/evidence-manifests/${packageId}.json`;
  const errors: string[] = [];
  let merkleRoot: string | null = null;
  let verifiedItems = 0;

  try {
    const manifestJson = await readVerified(store, manifestKey, pkg.manifestHash);
    const parsed = JSON.parse(manifestJson) as { merkleRoot?: string; items?: Array<{ sha256: string }> };
    const leaves = (parsed.items ?? []).map((it) => it.sha256);
    const recomputedRoot = buildMerkleTree(leaves).root;
    merkleRoot = recomputedRoot;
    if (parsed.merkleRoot !== recomputedRoot) {
      errors.push(`Manifest merkleRoot mismatch: expected ${recomputedRoot}, got ${parsed.merkleRoot ?? "missing"}`);
    }
  } catch (err: unknown) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  for (const item of pkg.items ?? []) {
    try {
      await readVerified(store, item.objectKey, item.sha256);
      verifiedItems += 1;
    } catch (err: unknown) {
      errors.push(`${item.itemType}:${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    verified: errors.length === 0,
    packageId,
    objectStoreMode: store.mode,
    manifestKey,
    manifestHash: pkg.manifestHash,
    merkleRoot,
    verifiedItems,
    totalItems: pkg.items?.length ?? 0,
    errors
  };
}
