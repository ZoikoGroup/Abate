// backend/src/platform/merkle.ts
// Deterministic SHA-256 Merkle tree helper shared across Phase 4/5 evidence packs and CLI verifier.
// Uses explicit domain separation so leaf and internal node preimages never collide.

import { sha256Hex } from "./canonical";

export interface MerkleProofStep {
  sibling: string;
  position: "left" | "right";
}

export interface MerkleLeafProof {
  index: number;
  itemSha256: string;
  leafHash: string;
  proof: MerkleProofStep[];
}

export interface MerkleTreeResult {
  root: string;
  levels: string[][];
  leafProofs: MerkleLeafProof[];
}

export function hashMerkleLeaf(itemSha256: string): string {
  return sha256Hex(`abate.merkle.leaf.v1:${itemSha256}`);
}

export function hashMerkleNode(leftHex: string, rightHex: string): string {
  return sha256Hex(`abate.merkle.node.v1:${leftHex}:${rightHex}`);
}

export function buildMerkleTree(itemSha256s: string[]): MerkleTreeResult {
  if (itemSha256s.length === 0) {
    const emptyRoot = sha256Hex("abate.merkle.empty.v1");
    return {
      root: emptyRoot,
      levels: [[emptyRoot]],
      leafProofs: []
    };
  }

  const leaves = itemSha256s.map((sha) => hashMerkleLeaf(sha));
  const levels: string[][] = [leaves];

  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? current[i];
      next.push(hashMerkleNode(left, right));
    }
    levels.push(next);
    current = next;
  }

  const root = levels[levels.length - 1][0];
  const leafProofs: MerkleLeafProof[] = itemSha256s.map((itemSha256, leafIndex) => {
    const proof: MerkleProofStep[] = [];
    let idx = leafIndex;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const layer = levels[lvl];
      const isRightNode = idx % 2 === 1;
      const siblingIndex = isRightNode ? idx - 1 : idx + 1;
      const sibling = layer[siblingIndex] ?? layer[idx];
      proof.push({
        sibling,
        position: isRightNode ? "left" : "right"
      });
      idx = Math.floor(idx / 2);
    }
    return {
      index: leafIndex,
      itemSha256,
      leafHash: leaves[leafIndex],
      proof
    };
  });

  return { root, levels, leafProofs };
}

export function verifyMerkleProof(
  itemSha256: string,
  proof: MerkleProofStep[],
  expectedRoot: string
): boolean {
  let computed = hashMerkleLeaf(itemSha256);
  for (const step of proof) {
    computed =
      step.position === "left"
        ? hashMerkleNode(step.sibling, computed)
        : hashMerkleNode(computed, step.sibling);
  }
  return computed === expectedRoot;
}

