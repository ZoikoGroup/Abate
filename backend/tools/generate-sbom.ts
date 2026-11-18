// backend/tools/generate-sbom.ts
// Generates evidence/sbom.json from committed package manifests and lockfile hashes (G-28 / T-25).

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

function readJson(relPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), "utf-8"));
}

function sha256File(relPath: string): string | null {
  const full = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}

function getCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const backendPkg = readJson("backend/package.json");
  const frontendPkg = readJson("frontend/package.json");
  const testsPkg = readJson("tests/package.json");

  const sbom = {
    schemaVersion: "abate.sbom.v1",
    generatedAt: new Date().toISOString(),
    commit: getCommitSha(),
    lockfileSha256: {
      backend: sha256File("backend/package-lock.json"),
      frontend: sha256File("frontend/package-lock.json"),
      tests: sha256File("tests/package-lock.json")
    },
    components: {
      backendDependencies: backendPkg.dependencies || {},
      backendDevDependencies: backendPkg.devDependencies || {},
      frontendDependencies: frontendPkg.dependencies || {},
      frontendDevDependencies: frontendPkg.devDependencies || {},
      testsDevDependencies: testsPkg.devDependencies || {}
    }
  };

  const outPath = path.join(REPO_ROOT, "evidence/sbom.json");
  fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2) + "\n", "utf-8");
  console.log(`✔ Wrote ${path.relative(REPO_ROOT, outPath)} (commit ${sbom.commit.slice(0, 8)})`);
}

main();
