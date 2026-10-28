// backend/tools/bootstrap.ts
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";
import path from "node:path";

function fail(message: string): never {
  console.error(`\x1b[31m[BOOTSTRAP ERROR]\x1b[0m ${message}`);
  process.exit(1);
}

console.log("\x1b[36m=== Abate Task Runner: bootstrap ===\x1b[0m");

// 1. Check runtime prerequisites
const need = [
  ["node", ["--version"]],
  ["npm", ["--version"]]
] as const;

for (const [cmd, args] of need) {
  const r = spawnSync(cmd, args as any, { shell: true });
  if (r.status !== 0) {
    fail(`Missing prerequisite: ${cmd}. Please install it, then re-run bootstrap.`);
  }
  const version = r.stdout.toString().trim();
  console.log(`  [OK] Prerequisite ${cmd} detected: ${version}`);
}

// 2. Ensure environment configuration exists
const envPath = path.resolve(process.cwd(), ".env");
const envExamplePath = path.resolve(process.cwd(), ".env.example");

if (!existsSync(envPath)) {
  if (existsSync(envExamplePath)) {
    console.log("  [INFO] .env not found. Creating from .env.example...");
    copyFileSync(envExamplePath, envPath);
  } else {
    fail("Neither .env nor .env.example found. Environment configuration required.");
  }
}
console.log("  [OK] Environment configuration verified.");
console.log("\x1b[32m[SUCCESS] Abate bootstrap completed successfully.\x1b[0m");

