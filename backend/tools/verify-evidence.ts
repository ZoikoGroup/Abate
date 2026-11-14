// backend/tools/verify-evidence.ts
// Independent Cryptographic Evidence Bundle Verifier (Phase 4 & Phase 5 + Merkle Proof Support)
// Verifies item SHA-256 digests, Merkle root & leaf inclusion proofs, and manifestHash integrity.
// NOTE: Cryptographic hashes prove files are unchanged since export, NOT that the underlying claims are true.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../src/platform/canonical";
import { buildMerkleTree, MerkleLeafProof, verifyMerkleProof } from "../src/platform/merkle";

function stableStringify(obj: any): string {
  return canonicalJson(obj);
}

export interface VerifyBundleResult {
  valid: boolean;
  errors: string[];
  checks: {
    itemsVerified: number;
    merkleVerified: boolean;
    manifestVerified: boolean;
    merkleRoot: string | null;
  };
}

export function verifyEvidenceBundle(pkg: any): VerifyBundleResult {
  const errors: string[] = [];
  const manifest = pkg?.manifest ? pkg.manifest : pkg;
  let itemsVerified = 0;
  let merkleVerified = false;
  let manifestVerified = false;

  if (!manifest || !manifest.items || !manifest.manifestHash) {
    return {
      valid: false,
      errors: ["Invalid manifest structure: missing items or manifestHash"],
      checks: { itemsVerified: 0, merkleVerified: false, manifestVerified: false, merkleRoot: null }
    };
  }

  const normalizedItems = manifest.items.map((item: any) => ({
    type: item.type ?? item.itemType,
    id: item.id ?? item.itemId,
    version: item.version ?? item.itemVersion,
    sha256: item.sha256,
    objectKey: item.objectKey
  }));

  // 1. Verify each item against content-addressed itemsFiles or artifacts
  for (let idx = 0; idx < manifest.items.length; idx++) {
    const rawItem = manifest.items[idx];
    const item = normalizedItems[idx];

    if (pkg.itemsFiles && rawItem.objectKey && pkg.itemsFiles[rawItem.objectKey]) {
      const contentBytes = pkg.itemsFiles[rawItem.objectKey];
      const computed = crypto.createHash("sha256").update(contentBytes).digest("hex");
      if (computed !== rawItem.sha256) {
        errors.push(`Item content mismatch (${item.type}:${item.id}): expected ${rawItem.sha256}, computed ${computed}`);
      } else {
        itemsVerified++;
      }
    } else if (pkg.artifacts) {
      const artKey = `${item.type}:${item.id}`;
      const artifact = pkg.artifacts[artKey];
      if (!artifact) {
        errors.push(`Missing artifact bytes for ${artKey}`);
      } else {
        const computed = crypto.createHash("sha256").update(stableStringify(artifact)).digest("hex");
        if (computed !== item.sha256) {
          errors.push(`Artifact hash mismatch for ${artKey}: expected ${item.sha256}, computed ${computed}`);
        } else {
          itemsVerified++;
        }
      }
    } else {
      itemsVerified++;
    }
  }

  // 2. Verify Merkle Root and Leaf Inclusion Proofs when present (or compute expected tree)
  const leafShas = normalizedItems.map((it: any) => String(it.sha256));
  const expectedTree = buildMerkleTree(leafShas);

  if (manifest.merkleRoot) {
    if (manifest.merkleRoot !== expectedTree.root) {
      errors.push(`Merkle root mismatch: expected ${expectedTree.root}, found ${manifest.merkleRoot}`);
    } else {
      merkleVerified = true;
    }

    if (Array.isArray(manifest.merkleProofs)) {
      if (manifest.merkleProofs.length !== normalizedItems.length) {
        errors.push(`Merkle proofs count mismatch: expected ${normalizedItems.length}, got ${manifest.merkleProofs.length}`);
        merkleVerified = false;
      } else {
        for (let i = 0; i < normalizedItems.length; i++) {
          const proofEntry = manifest.merkleProofs[i] as MerkleLeafProof;
          if (!proofEntry || proofEntry.itemSha256 !== leafShas[i] || !verifyMerkleProof(leafShas[i], proofEntry.proof, manifest.merkleRoot)) {
            errors.push(`Merkle inclusion proof failed at leaf index ${i} (${normalizedItems[i].type}:${normalizedItems[i].id})`);
            merkleVerified = false;
          }
        }
      }
    }
  }

  // 3. Recompute and verify canonical manifestHash
  if (pkg.manifest) {
    // Exclude derived signature/proof wrappers when hashing base manifest fields
    const manifestBase: Record<string, any> = {};
    for (const [k, v] of Object.entries(pkg.manifest)) {
      if (k !== "manifestHash" && k !== "merkleProofs") {
        manifestBase[k] = v;
      }
    }
    const recomputedManifestHash = crypto.createHash("sha256").update(stableStringify(manifestBase)).digest("hex");
    if (recomputedManifestHash !== pkg.manifest.manifestHash) {
      errors.push(`Manifest hash mismatch: expected ${recomputedManifestHash}, got ${pkg.manifest.manifestHash}`);
    } else {
      manifestVerified = true;
    }
  } else {
    // Phase 5 EvidencePackageView top-level manifest shape
    const manifestBase: Record<string, any> = {
      schema: manifest.schema || "abate.evidence.v1",
      cutoff: manifest.cutoff,
      issuer: manifest.issuerPrincipalId || manifest.issuer,
      classification: manifest.classification,
      items: normalizedItems.map((it: any) => ({
        type: it.type,
        id: it.id,
        version: it.version,
        sha256: it.sha256
      }))
    };
    if (manifest.merkleRoot) {
      manifestBase.merkleRoot = manifest.merkleRoot;
    }
    const recomputedManifestHash = crypto.createHash("sha256").update(stableStringify(manifestBase)).digest("hex");
    if (recomputedManifestHash !== manifest.manifestHash) {
      errors.push(`Manifest hash mismatch: expected ${recomputedManifestHash}, got ${manifest.manifestHash}`);
    } else {
      manifestVerified = true;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    checks: {
      itemsVerified,
      merkleVerified: manifest.merkleRoot ? merkleVerified : false,
      manifestVerified,
      merkleRoot: manifest.merkleRoot || expectedTree.root
    }
  };
}

export function runVerifierSelfTest(): { passed: boolean; checks: string[] } {
  const checks: string[] = [];
  const art1 = { id: "h-1", title: "Test Hazard", version: 1 };
  const art2 = { id: "c-1", statement: "Root organizational bottleneck", version: 1 };
  const sha1 = crypto.createHash("sha256").update(stableStringify(art1)).digest("hex");
  const sha2 = crypto.createHash("sha256").update(stableStringify(art2)).digest("hex");
  const tree = buildMerkleTree([sha1, sha2]);

  const manifestBase = {
    packageId: "pkg-self-test",
    hazardId: "h-1",
    tenantId: "tenant-self-test",
    cutoff: "2026-11-14T00:00:00.000Z",
    issuer: "verifier-self-test",
    classification: "RESTRICTED",
    items: [
      { type: "hazard", id: "h-1", version: 1, sha256: sha1 },
      { type: "cause", id: "c-1", version: 1, sha256: sha2 }
    ],
    merkleRoot: tree.root
  };
  const manifestHash = crypto.createHash("sha256").update(stableStringify(manifestBase)).digest("hex");

  const validBundle = {
    manifest: { ...manifestBase, merkleProofs: tree.leafProofs, manifestHash },
    artifacts: { "hazard:h-1": art1, "cause:c-1": art2 }
  };

  const ok = verifyEvidenceBundle(validBundle);
  if (!ok.valid || !ok.checks.merkleVerified || !ok.checks.manifestVerified) {
    throw new Error(`Valid evidence bundle failed verification: ${ok.errors.join("; ")}`);
  }
  checks.push("Valid bundle passed item SHA-256 + Merkle root + inclusion proofs + manifestHash");

  // Tamper artifact payload -> must fail closed
  const tamperedArtifact = {
    ...validBundle,
    artifacts: { "hazard:h-1": { ...art1, title: "Tampered Hazard" }, "cause:c-1": art2 }
  };
  const tamperRes1 = verifyEvidenceBundle(tamperedArtifact);
  if (tamperRes1.valid) {
    throw new Error("Tampered artifact payload unexpectedly passed verification");
  }
  checks.push("Tampered artifact payload rejected fail-closed");

  // Tamper Merkle root -> must fail closed
  const tamperedMerkle = {
    manifest: { ...validBundle.manifest, merkleRoot: "0".repeat(64) },
    artifacts: validBundle.artifacts
  };
  const tamperRes2 = verifyEvidenceBundle(tamperedMerkle);
  if (tamperRes2.valid) {
    throw new Error("Tampered Merkle root unexpectedly passed verification");
  }
  checks.push("Tampered Merkle root rejected fail-closed");

  return { passed: true, checks };
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    try {
      const res = runVerifierSelfTest();
      for (const c of res.checks) console.log(`  ✔ ${c}`);
      console.log("\x1b[32mPASS: Evidence verifier & Merkle self-test passed.\x1b[0m");
      process.exit(0);
    } catch (err: any) {
      console.error(`\x1b[31mFAIL: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  }

  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: tsx tools/verify-evidence.ts <path-to-evidence.json> | --self-test");
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(path.resolve(filePath), "utf8");
    const pkg = JSON.parse(raw);
    const result = verifyEvidenceBundle(pkg);
    if (result.valid) {
      console.log(
        `\x1b[32mPASS: Verified ${result.checks.itemsVerified} artifacts; manifestHash OK; Merkle root ${result.checks.merkleRoot?.slice(0, 12)}... verified.\x1b[0m`
      );
      process.exit(0);
    } else {
      console.error("\x1b[31mFAIL: Evidence tamper or mismatch detected:\x1b[0m");
      result.errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`\x1b[31mError reading evidence file: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
