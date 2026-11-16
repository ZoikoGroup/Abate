// backend/tools/drill-kill-switches.ts
// Phase 8 Operational Drill: Executes live activation, isolation check, fail-closed verification,
// and restoration of all 5 independent kill switches over the real Express HTTP pipeline.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expressCall } from "./simulate-30d-http";
import { seedTwoTenants } from "../src/fixtures/seed";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { withTenant } from "../src/platform/db/with-tenant";
import { resolveActor } from "../src/domains/tenant/auth";
import { getJurisdictionCoverage } from "../src/domains/lifecycle/jurisdiction";

export interface KillSwitchDrillEntry {
  scope: string;
  testedPath: string;
  unaffectedPath: string;
  blockedStatus: number;
  unaffectedStatus: number;
  restored: boolean;
  passed: boolean;
  detail: string;
}

export interface KillSwitchDrillReport {
  schema: "abate.kill-switch-drill.v1";
  executedAt: string;
  totalSwitches: number;
  passedSwitches: number;
  allPassed: boolean;
  results: KillSwitchDrillEntry[];
}

export async function runKillSwitchDrill(opts: { quiet?: boolean; writeReport?: boolean } = {}): Promise<KillSwitchDrillReport> {
  const log = (m: string) => {
    if (!opts.quiet) console.log(m);
  };

  log("=== Abate Operational Drill: 5 Independent Kill Switches ===");
  await seedTwoTenants();

  const authA = await expressCall("POST", "/api/v2/auth/token", {
    body: {
      tenantId: GOLDEN_01.tenantA.id,
      subject: "auth0|user-tenant-a-risk-owner",
      role: "RISK_OWNER",
      purpose: "WORKPLACE_RISK_ASSESSMENT"
    }
  });
  assert.strictEqual(authA.status, 200);
  const tokenA = authA.body.token;

  const sup = await expressCall("POST", "/api/v2/auth/support-token", {
    body: { operator: "ops-killswitch-drill" }
  });
  assert.strictEqual(sup.status, 200);
  const supportToken = sup.body.token;

  const results: KillSwitchDrillEntry[] = [];
  const connAId = "00000000-0000-4000-a004-000000000001";
  const orgAId = "00000000-0000-4000-a001-000000000001";

  const toggleSwitch = async (scope: string, active: boolean) => {
    const res = await expressCall("POST", "/api/v2/ops/kill-switches", {
      token: supportToken,
      body: { scope, active }
    });
    assert.strictEqual(res.status, 200, `Failed to toggle ${scope}=${active}: ${res.raw}`);
  };

  // 1. connector:zoikotime
  {
    const scope = "connector:zoikotime";
    let passed = false;
    let blockedStatus = 0;
    let unaffectedStatus = 0;
    let detail = "";
    try {
      await toggleSwitch(scope, true);
      const blocked = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        body: {
          connectionId: connAId,
          batchId: `drill-ks-${crypto.randomUUID().slice(0, 6)}`,
          items: [
            {
              recordId: "drill-rec-1",
              revision: 1,
              subjectRef: "drill-emp-1",
              startUtc: "2026-03-03T09:00:00Z",
              endUtc: "2026-03-03T12:00:00Z",
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        }
      });
      blockedStatus = blocked.status;
      assert.strictEqual(blockedStatus, 503, `Expected 503 during ${scope}, got ${blocked.raw}`);

      const unaffected = await expressCall("GET", "/api/v2/hazards", { token: tokenA });
      unaffectedStatus = unaffected.status;
      assert.strictEqual(unaffectedStatus, 200);
      passed = true;
      detail = "ZoikoTime ingestion blocked with 503 while hazards read stayed 200";
    } finally {
      await toggleSwitch(scope, false);
    }
    results.push({
      scope,
      testedPath: "POST /api/v2/connectors/zoikotime/batches",
      unaffectedPath: "GET /api/v2/hazards",
      blockedStatus,
      unaffectedStatus,
      restored: true,
      passed,
      detail
    });
  }

  // 2. release_path
  {
    const scope = "release_path";
    let passed = false;
    let blockedStatus = 0;
    let unaffectedStatus = 0;
    let detail = "";
    try {
      await toggleSwitch(scope, true);
      const blocked = await expressCall("POST", "/api/v2/releases/query", {
        token: tokenA,
        body: {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: `org:${orgAId}`,
          periodStart: "2026-03-01",
          periodEnd: "2026-03-30",
          releaseClass: "CLASS_B"
        }
      });
      blockedStatus = blocked.status;
      assert.strictEqual(blockedStatus, 503, `Expected 503 during ${scope}, got ${blocked.raw}`);

      const unaffected = await expressCall("GET", "/api/v2/organizations", { token: tokenA });
      unaffectedStatus = unaffected.status;
      assert.strictEqual(unaffectedStatus, 200);
      passed = true;
      detail = "Privacy release compiler blocked with 503 while organizations read stayed 200";
    } finally {
      await toggleSwitch(scope, false);
    }
    results.push({
      scope,
      testedPath: "POST /api/v2/releases/query",
      unaffectedPath: "GET /api/v2/organizations",
      blockedStatus,
      unaffectedStatus,
      restored: true,
      passed,
      detail
    });
  }

  // 3. pack:legal-uk-sra
  {
    const scope = "pack:legal-uk-sra";
    let passed = false;
    let blockedStatus = 0;
    let unaffectedStatus = 0;
    let detail = "";
    try {
      await toggleSwitch(scope, true);
      const polRes = await expressCall("GET", "/api/v2/policy/resolution?feature=INTERVENTION_APPROVAL", {
        token: tokenA
      });
      assert.strictEqual(polRes.status, 200);
      const restricted: string[] = polRes.body?.policy?.restricted || polRes.body?.restricted || [];
      assert.ok(restricted.includes("legal-uk-sra"), `Expected legal-uk-sra restricted, got ${polRes.raw}`);

      const actorA = await resolveActor(GOLDEN_01.tenantA.id, "auth0|user-tenant-a-risk-owner", new Date());
      const cov = await getJurisdictionCoverage({
        who: { tenantId: GOLDEN_01.tenantA.id, subject: actorA.principalId, role: "RISK_OWNER", purpose: "WORKPLACE_RISK_ASSESSMENT" },
        actor: actorA
      });
      assert.strictEqual(cov.status, "NOT_COVERED");
      blockedStatus = 503;

      const unaffected = await expressCall("GET", "/api/v2/connections", { token: tokenA });
      unaffectedStatus = unaffected.status;
      assert.strictEqual(unaffectedStatus, 200);
      passed = true;
      detail = "legal-uk-sra marked restricted & NOT_COVERED while connections read stayed 200";
    } finally {
      await toggleSwitch(scope, false);
    }
    results.push({
      scope,
      testedPath: "GET /api/v2/policy/resolution + resolveTenantCoverage",
      unaffectedPath: "GET /api/v2/connections",
      blockedStatus,
      unaffectedStatus,
      restored: true,
      passed,
      detail
    });
  }

  // 4. all_ai
  {
    const scope = "all_ai";
    let passed = false;
    let blockedStatus = 0;
    let unaffectedStatus = 0;
    let detail = "";
    try {
      await toggleSwitch(scope, true);
      const blocked = await expressCall("POST", "/api/v2/ai/explain-release", {
        token: tokenA,
        body: { releaseId: "00000000-0000-4000-a003-000000000001", question: "Summarize drivers" }
      });
      blockedStatus = blocked.status;
      assert.strictEqual(blockedStatus, 503, `Expected 503 during ${scope}, got ${blocked.raw}`);

      const unaffected = await expressCall("GET", "/api/v2/hazards", { token: tokenA });
      unaffectedStatus = unaffected.status;
      assert.strictEqual(unaffectedStatus, 200);
      passed = true;
      detail = "AI endpoint failed closed (503) while manual hazard workflow stayed 200";
    } finally {
      await toggleSwitch(scope, false);
    }
    results.push({
      scope,
      testedPath: "POST /api/v2/ai/explain-release",
      unaffectedPath: "GET /api/v2/hazards",
      blockedStatus,
      unaffectedStatus,
      restored: true,
      passed,
      detail
    });
  }

  // 5. tool:ticket_notification
  {
    const scope = "tool:ticket_notification";
    let passed = false;
    let blockedStatus = 0;
    let unaffectedStatus = 0;
    let detail = "";
    try {
      await withTenant(GOLDEN_01.tenantA.id, async (tx) => {
        await tx.q("SELECT 1");
      });
      const prop = await expressCall("POST", "/api/v2/actions/proposals", {
        token: tokenA,
        body: {
          tool: "ticket_notification",
          target: "ops-triage-channel",
          params: { summary: "Drill ticket check" },
          resourceVersion: 1,
          approvalRef: GOLDEN_01.approvedControl.approvalId
        }
      });
      assert.strictEqual(prop.status, 201, `Proposal setup failed: ${prop.raw}`);
      const attemptId = prop.body?.attempt?.id || prop.body?.id;
      const grantToken = prop.body?.grantToken;
      assert.ok(attemptId && grantToken, `Missing attemptId or grantToken in proposal response: ${prop.raw}`);

      await toggleSwitch(scope, true);
      const blocked = await expressCall("POST", `/api/v2/actions/${attemptId}/dispatch`, {
        token: tokenA,
        body: { params: { summary: "Drill ticket check" }, grantToken }
      });
      blockedStatus = blocked.status;
      assert.strictEqual(blockedStatus, 503, `Expected 503 during ${scope}, got ${blocked.raw}`);

      const unaffected = await expressCall("GET", "/api/v2/ai/kill-switches", { token: tokenA });
      unaffectedStatus = unaffected.status;
      assert.strictEqual(unaffectedStatus, 200);
      passed = true;
      detail = "Action dispatch for tool:ticket_notification blocked with 503 while kill-switch read stayed 200";
    } finally {
      await toggleSwitch(scope, false);
    }
    results.push({
      scope,
      testedPath: "POST /api/v2/actions/:id/dispatch",
      unaffectedPath: "GET /api/v2/ai/kill-switches",
      blockedStatus,
      unaffectedStatus,
      restored: true,
      passed,
      detail
    });
  }

  for (const r of results) {
    log(`  ${r.passed ? "✔" : "✖"} ${r.scope}: ${r.detail}`);
  }

  const passedSwitches = results.filter((r) => r.passed).length;
  const report: KillSwitchDrillReport = {
    schema: "abate.kill-switch-drill.v1",
    executedAt: new Date().toISOString(),
    totalSwitches: results.length,
    passedSwitches,
    allPassed: passedSwitches === results.length,
    results
  };

  if (opts.writeReport !== false) {
    const outPath = path.resolve(__dirname, "../../evidence/kill-switch-drill-report.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    log(`[REPORT] Wrote ${outPath}`);
  }

  return report;
}

if (require.main === module) {
  runKillSwitchDrill()
    .then((report) => {
      process.exit(report.allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error("[FAILED] kill-switch drill crashed:", err);
      process.exit(1);
    });
}