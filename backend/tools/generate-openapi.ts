// backend/tools/generate-openapi.ts
// Completion Plan Section 6 / G-13 / T-20:
// Materializes docs/openapi.json from backend/src/contracts/openapi.ts (single source of truth)
// and verifies that every /api/v2/* endpoint called by frontend/src/api/client.ts is documented.

import fs from "node:fs";
import path from "node:path";
import { openApiSpec } from "../src/contracts/openapi";

const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_PATH = path.join(REPO_ROOT, "docs/openapi.json");
const CLIENT_PATH = path.join(REPO_ROOT, "frontend/src/api/client.ts");
const CHECK_ONLY = process.argv.includes("--check");

function normalizeRouteTemplate(raw: string): string[] {
  const base = raw
    .replace(/^\/api\/v2/, "")
    .replace(/\?.*$/, "")
    .replace(/\$\{qs\}$/, "");
  if (base === "/connections/${connectionId}/${action}") {
    return ["pause", "resume", "suspend", "disconnect", "revoke"].map(
      (a) => `/connections/{id}/${a}`
    );
  }
  return [base.replace(/\$\{[^}]+\}/g, "{id}")];
}

function main() {
  console.log("\x1b[36m=== Abate OpenAPI Contract Export & Client Drift Check ===\x1b[0m\n");

  const specJson = JSON.stringify(openApiSpec, null, 2) + "\n";
  const specPaths = new Set(Object.keys((openApiSpec as any).paths || {}));

  // Verify every /api/v2/* call in frontend/src/api/client.ts matches an OpenAPI path
  const clientSrc = fs.readFileSync(CLIENT_PATH, "utf-8");
  const matches = clientSrc.match(/["'`]\/api\/v2\/[^"'`]+["'`]/g) || [];
  const missingFromSpec: string[] = [];

  for (const m of matches) {
    const raw = m.slice(1, -1);
    if (raw === "/api/v2/contracts/openapi.json") continue;
    for (const norm of normalizeRouteTemplate(raw)) {
      const wildcardRegex = new RegExp(
        "^" +
          norm
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\\\{id\\\}/g, "\\{[^}]+\\}") +
          "$"
      );
      const matched = Array.from(specPaths).some((p) => wildcardRegex.test(p));
      if (!matched) {
        missingFromSpec.push(`${raw} (normalized: ${norm})`);
      }
    }
  }

  if (missingFromSpec.length > 0) {
    console.error("  \x1b[31m✖\x1b[0m Frontend client paths missing from openapi.ts:");
    for (const item of new Set(missingFromSpec)) {
      console.error(`    - ${item}`);
    }
    process.exit(1);
  }
  console.log(`  \x1b[32m✔\x1b[0m Frontend client.ts routes (${matches.length} call sites) match ${specPaths.size} OpenAPI paths.`);

  if (CHECK_ONLY) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error("  \x1b[31m✖\x1b[0m docs/openapi.json is missing. Run: npm --prefix backend run generate:openapi");
      process.exit(1);
    }
    const existing = fs.readFileSync(OUT_PATH, "utf-8");
    if (existing !== specJson) {
      console.error("  \x1b[31m✖\x1b[0m docs/openapi.json is out of date. Run: npm --prefix backend run generate:openapi");
      process.exit(1);
    }
    console.log("  \x1b[32m✔\x1b[0m docs/openapi.json is in sync with backend/src/contracts/openapi.ts.\n");
    return;
  }

  fs.writeFileSync(OUT_PATH, specJson, "utf-8");
  console.log(`  \x1b[32m✔\x1b[0m Wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${specPaths.size} paths).\n`);
}

main();
