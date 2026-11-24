// backend/tools/lint-sector-neutrality.ts
// Fails CI when legal-sector wording appears in the sector-neutral core.
// Sector wording belongs in a sector pack. The neutral core, the other sector packs and the screens
// must not hard-code it. Files that legitimately hold legal wording are listed below, each with a reason.

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["backend/src", "frontend/src"];
const EXTENSIONS = new Set([".ts", ".tsx"]);

/** Legal-only terms. Generic English such as "that matters" or "legal hold" is deliberately not listed. */
const LEGAL_TERMS: Array<{ id: string; pattern: RegExp }> = [
  { id: "legal-profession", pattern: /\b(lawyers?|solicitors?|paralegals?|barristers?|attorneys?)\b/i },
  { id: "sra", pattern: /\bsra\b/i },
  { id: "litigation", pattern: /\b(litigation|arbitration)\b/i },
  { id: "practice-area", pattern: /\bpractice[ _-]?areas?\b/i },
  { id: "supervisory-partner", pattern: /\bsupervisory[ _-]partner\b/i },
  { id: "trial-window", pattern: /\b(TRIAL_PREP|CLOSING_TRANSACTION|trial prep)\b/i },
  { id: "matter-field", pattern: /\b(matterId|matterTitle|matterRef|matter_ref|MATTER-[A-Z0-9-]+)\b/ }
];

/** Files allowed to contain legal wording, with the reason. Keep this list short and specific. */
const ALLOWED: Record<string, string> = {
  "backend/src/domains/lifecycle/packs/legal.ts": "the legal sector pack itself",
  "backend/src/domains/sector-legal/index.ts": "legal field-name adapter over the neutral work item",
  "backend/src/routes/sector-work.ts": "legal-named alias routes kept for existing clients",
  "backend/src/fixtures/seed.ts": "demo tenants and policy packs for the legal sector",
  "backend/src/fixtures/sector-work-items.ts": "synthetic demo items, tagged by sector",
  "backend/src/domains/ai/run.ts": "the prohibited-request screen lists people nouns for every sector",
  "backend/src/contracts/retention.ts": "deprecated matterRef alias of the neutral hold reference",
  "backend/src/domains/lifecycle/retention.ts": "stored column name matter_ref, kept until a safe migration",
  "backend/src/platform/db/mem-db.ts": "in-memory store mirrors the stored matter_ref column",
  "backend/src/contracts/openapi.ts": "documents the legal alias routes",
  "frontend/src/api/client.ts": "deprecated matter_ref field on the hold view, demo tenant names",
  "frontend/src/components/Tabs/RetentionTab.tsx": "falls back to the deprecated matter_ref field",
  "frontend/src/components/Tabs/OperationsTab.tsx": "kill-switch scope label for the seeded legal jurisdiction pack",
  "frontend/src/utils/sector-simulations.ts": "multi-sector interactive simulation presets and cross-sector boundary decoy fixtures"
};

function collect(dir: string, out: string[] = []): string[] {
  const full = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const item of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, item.name).replace(/\\/g, "/");
    if (item.isDirectory()) {
      if (item.name === "node_modules" || item.name === "dist") continue;
      collect(rel, out);
    } else if (EXTENSIONS.has(path.extname(item.name))) {
      out.push(rel);
    }
  }
  return out;
}

const REPORT_ONLY = process.argv.includes("--report");
console.log("\x1b[36m=== Abate Sector Neutrality Lint ===\x1b[0m\n");

const files = SCAN_DIRS.flatMap(d => collect(d));
const violations: string[] = [];
const staleAllowances = new Set(Object.keys(ALLOWED));

for (const rel of files) {
  const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8").split(/\r?\n/);
  const allowed = rel in ALLOWED;
  let hit = false;
  lines.forEach((line, i) => {
    for (const term of LEGAL_TERMS) {
      const m = line.match(term.pattern);
      if (!m) continue;
      hit = true;
      if (!allowed) violations.push(`${rel}:${i + 1} [${term.id}] "${m[0]}": ${line.trim().slice(0, 110)}`);
    }
  });
  if (allowed && hit) staleAllowances.delete(rel);
}

for (const v of violations) console.error(`  \x1b[31m✖\x1b[0m ${v}`);
for (const stale of staleAllowances) {
  console.error(`  \x1b[33m!\x1b[0m allowlist entry has no legal wording any more, remove it: ${stale}`);
}

const failed = violations.length > 0 || staleAllowances.size > 0;
if (!failed) {
  console.log(`  \x1b[32m✔\x1b[0m Scanned ${files.length} files: legal wording appears only in ${Object.keys(ALLOWED).length} allowed files.`);
}
process.exit(failed && !REPORT_ONLY ? 1 : 0);
