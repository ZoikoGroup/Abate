// backend/tools/verify-evidence.ts
// Standalone Evidence Verifier CLI (Playbook B5 §3 Step 7)
// Rule: Standalone tool that does NOT import database or application code.
// Another engineer can run it using only the exported package directory or JSON file.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function sha256Hex(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function verifyEvidenceBundle(pkg: {
  manifest: {
    schema?: string;
    cutoff: string;
    issuer: string;
    classification: string;
    items: Array<{ type: string; id: string; version: number; sha256: string }>;
    manifestHash: string;
  };
  artifacts?: Array<{
    type: string;
    id: string;
    version: number;
    sha256: string;
    data: any;
  }>;
  itemsFiles?: Record<string, string>;
}): { valid: boolean; bad: number; errors: string[] } {
  let bad = 0;
  const errors: string[] = [];

  // 1. Verify each item
  for (const it of pkg.manifest.items) {
    let rawContent: string | null = null;

    if (pkg.itemsFiles && pkg.itemsFiles[it.sha256]) {
      rawContent = pkg.itemsFiles[it.sha256];
    } else if (pkg.artifacts) {
      const art = pkg.artifacts.find(a => a.id === it.id && a.type === it.type && a.version === it.version);
      if (art) {
        // Re-hash canonical json of artifact data
        const sorted = JSON.stringify(art.data, Object.keys(art.data || {}).sort());
        rawContent = sorted;
      }
    }

    if (!rawContent) {
      errors.push(`MISSING_ITEM: ${it.type} ${it.id} v${it.version} (sha: ${it.sha256.slice(0, 8)})`);
      bad++;
      continue;
    }

    const got = sha256Hex(rawContent);
    if (got !== it.sha256) {
      errors.push(`HASH_MISMATCH: ${it.type} ${it.id} v${it.version} - expected ${it.sha256.slice(0, 16)}... got ${got.slice(0, 16)}...`);
      bad++;
    }
  }

  return {
    valid: bad === 0,
    bad,
    errors
  };
}

// CLI runner if invoked directly from command line
if (process.argv[1] && process.argv[1].endsWith("verify-evidence.ts")) {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.log("Usage: tsx tools/verify-evidence.ts <path-to-package.json>");
    process.exit(0);
  }

  try {
    const raw = fs.readFileSync(path.resolve(targetPath), "utf8");
    const parsed = JSON.parse(raw);
    const res = verifyEvidenceBundle(parsed);
    if (res.valid) {
      console.log(`\x1b[32m✔ OK: all ${parsed.manifest.items.length} items match manifest (${parsed.manifest.manifestHash})\x1b[0m`);
      process.exit(0);
    } else {
      console.error(`\x1b[31m✖ FAILED: ${res.bad} item(s) altered or mismatched:\x1b[0m`);
      res.errors.forEach(e => console.error(`  - ${e}`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`\x1b[31mError reading evidence file: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
