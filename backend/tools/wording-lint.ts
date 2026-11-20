// backend/tools/wording-lint.ts
// Completion Plan Wave 0 T-04 / G-33:
// Fails CI if banned overclaim phrases return to UI, backend responses/contracts, or active docs.
// Negative-test fixtures / explicit prohibition explanations (e.g. "no differential privacy",
// "never claim SRA compliance") are excluded so constitutional prohibitions stay explicit.

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

const SCAN_DIRS = [
  "backend/src",
  "frontend/src",
  "docs/button-and-endpoint-checklist.md",
  "docs/architecture",
  "docs/governance"
];

interface BannedRule {
  id: string;
  pattern: RegExp;
  allowLinePattern?: RegExp;
  message: string;
}

const BANNED_RULES: BannedRule[] = [
  {
    id: "NO_DIFFERENTIAL_PRIVACY_CLAIM",
    pattern: /\bdifferential privacy\b/i,
    allowLinePattern: /\b(no|not|never|zero|without|prohibit|prohibits|prohibiting|removed|ban|banned|instead of|vs\.?)\b.{0,40}\bdifferential privacy\b|\bdifferential privacy\b.{0,30}\b(prohibited|banned|removed|unapproved)\b|["']differential privacy["']/i,
    message: "Unapproved 'differential privacy' claim (G-03 / G-33)"
  },
  {
    id: "NO_SRA_COMPLIANCE_CERTIFICATION",
    pattern: /\bSRA(?:\s+2023)?\s+compliance\b/i,
    allowLinePattern: /\b(no|not|never|prohibit|removed|cannot|does not)\b.{0,40}\bSRA(?:\s+2023)?\s+compliance\b|["']SRA(?:\s+2023)?\s+Compliance["']/i,
    message: "Overclaiming 'SRA compliance' instead of 'SRA-aligned' (G-07 / G-33)"
  },
  {
    id: "NO_PRODUCTION_READY_CLAIM",
    pattern: /\b(production[- ]ready|certified\s+compliant|legally\s+compliant)\b/i,
    allowLinePattern: /\b(not|no|never|no claim of|does not claim|prohibit)\b.{0,40}\b(production[- ]ready|certified\s+compliant|legally\s+compliant)\b/i,
    message: "Overclaiming production readiness or legal certification (G-33)"
  },
  {
    id: "NO_COMPLIANT_BADGE_OVERCLAIM",
    pattern: /\bCOMPLIANT:\s*NORMAL\s+VARIANCE\b/i,
    allowLinePattern: /\b(no|not|never|removed|replaced)\b/i,
    message: "UI badge must not claim 'COMPLIANT' without legal approval; use 'WITHIN THRESHOLD' (G-33 / §7.1)"
  }
];

function collectFiles(entryPath: string): string[] {
  const full = path.join(REPO_ROOT, entryPath);
  if (!fs.existsSync(full)) return [];
  const stat = fs.statSync(full);
  if (stat.isFile()) return [full];
  const out: string[] = [];
  for (const item of fs.readdirSync(full, { withFileTypes: true })) {
    if (item.name === "node_modules" || item.name === "dist" || item.name.startsWith(".")) continue;
    const subRel = path.join(entryPath, item.name);
    if (item.isDirectory()) {
      out.push(...collectFiles(subRel));
    } else if (/\.(ts|tsx|js|jsx|md|json|yaml|yml)$/.test(item.name)) {
      out.push(path.join(REPO_ROOT, subRel));
    }
  }
  return out;
}

function main() {
  console.log("\x1b[36m=== Abate Wording & Overclaim Lint (T-04 / G-33) ===\x1b[0m\n");
  const files = SCAN_DIRS.flatMap(collectFiles);
  let violations = 0;

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    if (rel.endsWith("wording-lint.ts")) continue;
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rule of BANNED_RULES) {
        if (rule.pattern.test(line)) {
          if (rule.allowLinePattern && rule.allowLinePattern.test(line)) {
            continue;
          }
          violations++;
          console.error(`  \x1b[31m✖\x1b[0m [${rule.id}] ${rel}:${idx + 1}: ${rule.message}`);
          console.error(`    ${line.trim()}`);
        }
      }
    });
  }

  if (violations > 0) {
    console.error(`\n\x1b[31m[WORDING-LINT FAILED]\x1b[0m ${violations} banned overclaim(s) detected.\n`);
    process.exit(1);
  }

  console.log(`  \x1b[32m✔\x1b[0m Scanned ${files.length} files with 0 overclaim violations.\n`);
}

main();
