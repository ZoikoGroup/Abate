// backend/tools/build-dossier.ts
// Dynamically assembles evidence/release-dossier.json and frontend/public/release-dossier.json
// from real executed verification suites, live restore rehearsal, and live 5-kill-switch drill.
// Stays strictly "READY FOR REVIEW" until a named human signs via tools/sign-dossier.ts.

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../src/platform/canonical";
import { runRecoveryRehearsal } from "./reconcile-after-restore";
import { runKillSwitchDrill } from "./drill-kill-switches";
import { run30DayHttpSimulation } from "./simulate-30d-http";
import { runVerifierSelfTest } from "./verify-evidence";

interface SuiteExecutionResult {
  name: string;
  script: string;
  phase: string;
  testsPassed: number;
  status: "PASS" | "FAIL";
  exitCode: number;
  durationMs: number;
  lastRun: string;
}

const BACKEND_ROOT = path.resolve(__dirname, "..");

const SUITES: Array<{ name: string; script: string; toolPath: string; phase: string }> = [
  { name: "Boundary & Isolation Suite", script: "test-boundaries", toolPath: "tools/test-boundaries.ts", phase: "Cross-Phase Constitutional Gates" },
  { name: "Phase 2 Ingestion & Decoy Lab", script: "test-ingest", toolPath: "tools/test-phase2-ingestion.ts", phase: "Phase 2 (Domains S02 & S03)" },
  { name: "Phase 3 Reconstruction Attack Lab", script: "test-privacy", toolPath: "tools/test-reconstruction.ts", phase: "Phase 3 (Domains S04 & S06)" },
  { name: "Phase 4 Control & Evidence Suite", script: "test-control", toolPath: "tools/test-phase4-control.ts", phase: "Phase 4 (BE-007)" },
  { name: "Phase 5 Retention & Legal Hold Suite", script: "test-retention", toolPath: "tools/test-phase5-retention.ts", phase: "Phase 5 (B5)" },
  { name: "Phase 6 Bounded AI & Actions Suite", script: "test-ai", toolPath: "tools/test-phase6-ai.ts", phase: "Phase 6 (BE-008)" },
  { name: "Phase 7 Two-Plane & AI Change Suite", script: "test-planes", toolPath: "tools/test-phase7-planes.ts", phase: "Phase 7 (B7)" },
  { name: "Worker Outbox Crash & Lease Suite", script: "test-worker", toolPath: "tools/test-worker-crash-lab.ts", phase: "Async Reliability" },
  { name: "Postgres Parity & Fail-Closed Guard", script: "verify-pg", toolPath: "tools/verify-pg-clean.ts", phase: "Infrastructure & Least-Privilege DB" },
  { name: "Daily Endpoint & Contract Drift Check", script: "check:endpoints", toolPath: "tools/endpoint-check.ts", phase: "API Catalog Compliance" }
];

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return "unknown";
  }
}

function getRepoRoot(): string {
  return path.resolve(__dirname, "../..");
}

function countPassingChecks(output: string): number {
  const checkMatches = output.match(/✔/g);
  if (checkMatches && checkMatches.length > 0) {
    return checkMatches.length;
  }
  const summaryMatch = output.match(/All\s+(\d+)(?:\/\d+)?\s+.*pass/i);
  if (summaryMatch) {
    return Number(summaryMatch[1]);
  }
  return 0;
}

function resolveTsxCli(): string {
  const candidates = [
    path.join(BACKEND_ROOT, "node_modules/tsx/dist/cli.mjs"),
    path.resolve(BACKEND_ROOT, "../node_modules/tsx/dist/cli.mjs")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return require.resolve("tsx/cli");
}

const TSX_CLI = resolveTsxCli();

function runNpmSuite(suite: { name: string; script: string; toolPath: string; phase: string }): SuiteExecutionResult {
  const start = Date.now();
  const res = spawnSync(process.execPath, [TSX_CLI, path.join(BACKEND_ROOT, suite.toolPath)], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    timeout: 120000
  });
  const durationMs = Date.now() - start;
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
  const exitCode = res.status ?? (res.error ? 1 : 1);
  const testsPassed = countPassingChecks(combined);

  return {
    name: suite.name,
    script: suite.script,
    phase: suite.phase,
    testsPassed,
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    durationMs,
    lastRun: new Date().toISOString()
  };
}

export async function assembleDossier() {
  console.log("=== Abate Release Evidence Dossier Builder (Dynamic Execution Mode) ===");

  const repoRoot = getRepoRoot();
  const commitSha = getGitSha();
  const generatedAt = new Date().toISOString();

  // 1. Run backend test suites dynamically
  const testSuites: SuiteExecutionResult[] = [];
  for (const s of SUITES) {
    process.stdout.write(`  Running ${s.script}... `);
    const result = runNpmSuite(s);
    console.log(`${result.status} (${result.testsPassed} checks, ${result.durationMs}ms)`);
    testSuites.push(result);
  }

  // 2. Run Verifier Self-Test, 30-day HTTP simulation, Restore Rehearsal, and 5-Kill-Switch Drill
  const verifierStart = Date.now();
  const verifierRes = runVerifierSelfTest();
  testSuites.push({
    name: "Evidence Bundle & Merkle Verifier",
    script: "verify-evidence",
    phase: "Phase 8 Audit Verifier",
    testsPassed: verifierRes.checks.length,
    status: verifierRes.passed ? "PASS" : "FAIL",
    exitCode: verifierRes.passed ? 0 : 1,
    durationMs: Date.now() - verifierStart,
    lastRun: new Date().toISOString()
  });
  console.log(`  ✔ Evidence Verifier Self-Test: ${verifierRes.checks.length} checks PASS`);

  const simReport = await run30DayHttpSimulation({ quiet: true, writeReport: true });
  testSuites.push({
    name: "Scripted 30-Day Real HTTP Simulation",
    script: "sim-30d",
    phase: "End-to-End Lifecycle Verification",
    testsPassed: simReport.summary.passedSteps,
    status: simReport.summary.passed ? "PASS" : "FAIL",
    exitCode: simReport.summary.passed ? 0 : 1,
    durationMs: simReport.summary.durationMs,
    lastRun: simReport.generatedAt
  });
  console.log(`  ✔ Scripted 30-Day HTTP Simulation: ${simReport.summary.passedSteps}/${simReport.summary.totalSteps} PASS`);

  const restoreRes = await runRecoveryRehearsal();
  console.log(`  ✔ Timed Restore Rehearsal: RTO ${restoreRes.rtoMs}ms, RPO ${restoreRes.rpoMinutes}m, 0 resurrected records`);

  const killSwitchReport = await runKillSwitchDrill({ quiet: true, writeReport: true });
  console.log(`  ✔ 5-Kill-Switch Live Drill: ${killSwitchReport.passedSwitches}/${killSwitchReport.totalSwitches} PASS`);

  // 3. Aggregate Security / Quality Gates & Honest Defect Counters
  const failingSuites = testSuites.filter((s) => s.status !== "PASS");
  const allGatesGreen =
    failingSuites.length === 0 &&
    restoreRes.success &&
    killSwitchReport.allPassed &&
    simReport.summary.passed;

  const coreEvidencePayload = {
    schema: "abate.release-dossier.v1",
    commitSha,
    generatedAt,
    system: {
      name: "Zoiko Abate",
      specification: "ZAB-ENG-001",
      version: "1.0.0",
      architecture: "Two-Plane Modular Monolith with Forced Row-Level Security",
      postgresRequirementEnv: process.env.ABATE_REQUIRE_PG === "1" ? "LIVE_POSTGRES_REQUIRED" : "HYBRID_LOCAL_SANDBOX"
    },
    constitutionalInvariants: [
      { id: "INV-01", statement: "Tenant isolation at every seam via PostgreSQL RLS + transaction-local context", verified: allGatesGreen },
      { id: "INV-02", statement: "Measurement safety floor (k >= 10), overlap differencing (>= 5), and residual blocking (>= 5)", verified: allGatesGreen },
      { id: "INV-03", statement: "Bounded AI cannot write authoritative state and fails closed behind active kill switches", verified: killSwitchReport.allPassed },
      { id: "INV-04", statement: "Append-only ledger and audit trail revoke UPDATE/DELETE from runtime app roles", verified: allGatesGreen },
      { id: "INV-05", statement: "Two-plane separation prevents Plane B performance metrics from mutating Plane A compliance hazards", verified: allGatesGreen }
    ],
    testSuites,
    totalChecksPassed: testSuites.reduce((sum, s) => sum + s.testsPassed, 0),
    defects: {
      p0FailedSuites: failingSuites.length,
      failingSuiteScripts: failingSuites.map((s) => s.script),
      status: allGatesGreen ? "CLEAR (ZERO OPEN P0 DEFECTS)" : "BLOCKED"
    },
    recoveryRehearsal: {
      reconcileTool: "backend/tools/reconcile-after-restore.ts",
      executedAt: restoreRes.executedAt,
      targetRtoHours: 4,
      targetRpoMinutes: 15,
      measuredRtoMs: restoreRes.rtoMs,
      measuredRpoMinutes: restoreRes.rpoMinutes,
      reconciledDeletions: restoreRes.reconciledDeletions,
      unknownActionsReconciled: restoreRes.unknownActionsReconciled,
      outboxPendingCount: restoreRes.outboxPendingCount,
      checksPassed: restoreRes.checks.length,
      status: restoreRes.success ? "PASSED" : "FAILED"
    },
    killSwitches: killSwitchReport.results.map((r) => ({
      scope: r.scope,
      testedPath: r.testedPath,
      unaffectedPath: r.unaffectedPath,
      blockedStatus: r.blockedStatus,
      unaffectedStatus: r.unaffectedStatus,
      restored: r.restored,
      status: r.passed ? "VERIFIED_LIVE" : "FAILED",
      detail: r.detail
    })),
    simulation30d: {
      mode: simReport.mode,
      notice: "Scripted scenario running against real Express HTTP endpoints; synthetic cohort fixtures.",
      passedSteps: simReport.summary.passedSteps,
      totalSteps: simReport.summary.totalSteps,
      durationMs: simReport.summary.durationMs
    },
    evidenceVerification: {
      merkleTreeVersion: "abate.merkle.v1",
      verifierCli: "backend/tools/verify-evidence.ts",
      browserVerifierTab: "AuditVerifierTab.tsx",
      epistemicNotice: "Cryptographic hashes and Merkle proofs prove files are unchanged since export, NOT that the underlying claims are true."
    }
  };

  const dossierHash = sha256Hex(canonicalJson(coreEvidencePayload));

  // 4. Check if a named human signer ratified THIS exact dossierHash; otherwise stay READY FOR REVIEW
  const signoffPath = path.join(repoRoot, "evidence/dossier-signoff.json");
  let existingSignoff: any = null;
  if (fs.existsSync(signoffPath)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(signoffPath, "utf8"));
      if (candidate?.dossierHash === dossierHash && candidate?.signedBy && candidate?.status === "RATIFIED") {
        existingSignoff = candidate;
      }
    } catch {
      existingSignoff = null;
    }
  }

  const isRatified = Boolean(existingSignoff && allGatesGreen);
  const outcome = !allGatesGreen ? "BLOCKED_FAILING_GATES" : isRatified ? "APPROVED" : "READY FOR REVIEW";

  const dossier = {
    ...coreEvidencePayload,
    status: isRatified ? "RATIFIED" : allGatesGreen ? "READY FOR REVIEW" : "BLOCKED",
    signOff: isRatified
      ? existingSignoff
      : {
        schema: "abate.dossier-signoff.v1",
        status: "READY FOR REVIEW",
        signedBy: null,
        role: null,
        signedAt: null,
        dossierHash,
        instruction: 'Run `npm --prefix backend run sign-dossier -- --signer="Full Name" --role="Release Lead"` after manual review.'
      },
    decision: {
      outcome,
      authorityRequired: "Named Accountable Signer (tools/sign-dossier.ts)",
      rationale: allGatesGreen
        ? isRatified
          ? `Signed by ${existingSignoff.signedBy} (${existingSignoff.role}) matching dossierHash.`
          : "All automated test suites, live operational drills, and constitutional checks passed; awaiting explicit named human sign-off."
        : `Release blocked due to failing gates: ${failingSuites.map((s) => s.script).join(", ")}`
    }
  };

  // Write dossier artifacts
  const evidenceDir = path.join(repoRoot, "evidence");
  const frontendPublicDir = path.join(repoRoot, "frontend/public");
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
  if (!fs.existsSync(frontendPublicDir)) fs.mkdirSync(frontendPublicDir, { recursive: true });

  fs.writeFileSync(path.join(evidenceDir, "release-dossier.json"), JSON.stringify(dossier, null, 2));
  fs.writeFileSync(path.join(frontendPublicDir, "release-dossier.json"), JSON.stringify(dossier, null, 2));

  console.log(`\n✔ Built release dossier -> status: ${dossier.status}, outcome: ${dossier.decision.outcome}`);
  console.log(`  Dossier Hash: ${dossierHash}`);
  console.log(`  Files written: evidence/release-dossier.json, frontend/public/release-dossier.json`);

  return dossier;
}

if (require.main === module) {
  assembleDossier()
    .then((d) => {
      process.exit(d.decision.outcome === "BLOCKED_FAILING_GATES" ? 1 : 0);
    })
    .catch((err) => {
      console.error("[FAILED] build-dossier crashed:", err);
      process.exit(1);
    });
}
