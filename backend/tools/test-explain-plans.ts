// backend/tools/test-explain-plans.ts
// Completion Plan Section 5.5 / G-25 / T-12:
// Runs EXPLAIN (FORMAT JSON) against live PostgreSQL for the five hot-path queries
// (release read, hazard list, outbox poll, disclosure ledger range, audit trail)
// and verifies supporting indexes exist in SQL migrations.

import fs from "node:fs";
import path from "node:path";
import { migratorPool, appPool, workerPool, releaseCompilerPool, protectedComputePool } from "../src/platform/db/with-tenant";
import { GOLDEN_01 } from "../src/fixtures/golden01";

const requireLive = process.argv.includes("--require-live");
const LARGE_TABLE_SEQ_SCAN_THRESHOLD = 1000;

function collectPlanNodes(node: any, out: Array<{ nodeType: string; relation?: string; actualRows: number }> = []): Array<{ nodeType: string; relation?: string; actualRows: number }> {
  if (!node || typeof node !== "object") return out;
  out.push({
    nodeType: String(node["Node Type"] || "Unknown"),
    relation: typeof node["Relation Name"] === "string" ? node["Relation Name"] : undefined,
    actualRows: Number(node["Actual Rows"] ?? 0)
  });
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) {
      collectPlanNodes(child, out);
    }
  }
  return out;
}

function assertNoLargeSeqScan(queryName: string, planRoot: any): string {
  const nodes = collectPlanNodes(planRoot);
  for (const n of nodes) {
    if (n.nodeType === "Seq Scan" && n.actualRows >= LARGE_TABLE_SEQ_SCAN_THRESHOLD) {
      throw new Error(
        `Hot-path query [${queryName}] performed Seq Scan on ${n.relation || "table"} with ${n.actualRows} rows (>= ${LARGE_TABLE_SEQ_SCAN_THRESHOLD}).`
      );
    }
  }
  return String(planRoot?.["Node Type"] || "Unknown");
}

async function isPgUp(): Promise<boolean> {
  if (!migratorPool) return false;
  try {
    const c = await migratorPool.connect();
    await c.query("SELECT 1");
    c.release();
    return true;
  } catch {
    return false;
  }
}

function checkMigrationIndexes(): void {
  const dir = path.resolve(__dirname, "../db/migrations");
  const sql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("\n");

  const expectedIndexes = [
    "idx_work_fact_tenant_kind_window",
    "idx_work_fact_revision_tenant_start",
    "idx_audit_event_tenant_time",
    "idx_outbox_event_poll",
    "idx_hazard_tenant_disposition",
    "idx_disclosure_ledger_tenant_metric",
    "idx_privacy_decision_tenant_query",
    "idx_async_job_tenant_created"
  ];

  for (const idx of expectedIndexes) {
    if (!sql.includes(idx)) {
      throw new Error(`Missing required hot-path index in migrations: ${idx}`);
    }
    console.log(`  \x1b[32m✔\x1b[0m Migration index declared: ${idx}`);
  }
}

async function main() {
  console.log("\x1b[36m=== Abate Hot-Path Query Plan & Index Verification (Section 5.5) ===\x1b[0m\n");
  checkMigrationIndexes();

  const pgUp = await isPgUp();
  if (!pgUp) {
    if (requireLive) {
      console.error("\x1b[31m[EXPLAIN FAILED]\x1b[0m --require-live specified, but PostgreSQL is offline.");
      process.exit(1);
    }
    console.log("\n\x1b[33m[INFO] PostgreSQL not reachable locally; skipping live EXPLAIN plans (runs in CI with --require-live).\x1b[0m\n");
    process.exit(0);
  }

  const tenantA = GOLDEN_01.tenantA.id;
  const appClient = await appPool!.connect();
  try {
    await appClient.query("BEGIN");
    await appClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

    const appQueries: Array<{ name: string; sql: string; params: any[] }> = [
      {
        name: "Release read",
        sql: `EXPLAIN (ANALYZE, FORMAT JSON) SELECT a.* FROM released_artifact a JOIN privacy_release r ON r.id = a.release_id WHERE a.release_id = $1`,
        params: ["00000000-0000-4000-a003-000000000001"]
      },
      {
        name: "Hazard list by tenant & disposition",
        sql: `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id, title, disposition FROM hazard WHERE tenant_id = $1 AND disposition = 'OPEN'`,
        params: [tenantA]
      },
      {
        name: "Audit trail by tenant & occurred_at DESC",
        sql: `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id, command, occurred_at FROM audit_event WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
        params: [tenantA]
      }
    ];

    for (const q of appQueries) {
      const res = await appClient.query(q.sql, q.params);
      const planRoot = res.rows[0]["QUERY PLAN"]?.[0]?.Plan;
      const planNode = assertNoLargeSeqScan(q.name, planRoot);
      const execMs = Number(res.rows[0]["QUERY PLAN"]?.[0]?.["Execution Time"] ?? 0).toFixed(2);
      console.log(`  \x1b[32m✔\x1b[0m EXPLAIN ANALYZE [${q.name}]: root node = ${planNode} (${execMs} ms)`);
    }
    await appClient.query("ROLLBACK");
  } finally {
    appClient.release();
  }

  const pcClient = await protectedComputePool!.connect();
  try {
    await pcClient.query("BEGIN");
    await pcClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const wfrPlan = await pcClient.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id, start_at FROM work_fact_revision WHERE tenant_id = $1 AND start_at >= $2 ORDER BY start_at LIMIT 100`,
      [tenantA, "2026-01-01T00:00:00Z"]
    );
    const wfrRoot = wfrPlan.rows[0]["QUERY PLAN"]?.[0]?.Plan;
    const node = assertNoLargeSeqScan("Work fact ledger range", wfrRoot);
    const execMs = Number(wfrPlan.rows[0]["QUERY PLAN"]?.[0]?.["Execution Time"] ?? 0).toFixed(2);
    console.log(`  \x1b[32m✔\x1b[0m EXPLAIN ANALYZE [Work fact ledger range]: root node = ${node} (${execMs} ms)`);
    await pcClient.query("ROLLBACK");
  } finally {
    pcClient.release();
  }

  const wClient = await workerPool!.connect();
  try {
    const outboxPlan = await wClient.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM outbox_event WHERE state = 'PENDING' AND published_at IS NULL ORDER BY next_retry_at LIMIT 25`
    );
    const outboxRoot = outboxPlan.rows[0]["QUERY PLAN"]?.[0]?.Plan;
    const node = assertNoLargeSeqScan("Outbox poll", outboxRoot);
    const execMs = Number(outboxPlan.rows[0]["QUERY PLAN"]?.[0]?.["Execution Time"] ?? 0).toFixed(2);
    console.log(`  \x1b[32m✔\x1b[0m EXPLAIN ANALYZE [Outbox poll]: root node = ${node} (${execMs} ms)`);
  } finally {
    wClient.release();
  }

  const rcClient = await releaseCompilerPool!.connect();
  try {
    await rcClient.query("BEGIN");
    await rcClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const ledgerPlan = await rcClient.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT cohort_members FROM disclosure_ledger WHERE tenant_id = $1 AND metric_id = 'BOUNDARY_INTRUSION_SHARE'`,
      [tenantA]
    );
    const ledgerRoot = ledgerPlan.rows[0]["QUERY PLAN"]?.[0]?.Plan;
    const node = assertNoLargeSeqScan("Disclosure ledger range", ledgerRoot);
    const execMs = Number(ledgerPlan.rows[0]["QUERY PLAN"]?.[0]?.["Execution Time"] ?? 0).toFixed(2);
    console.log(`  \x1b[32m✔\x1b[0m EXPLAIN ANALYZE [Disclosure ledger range]: root node = ${node} (${execMs} ms)`);
    await rcClient.query("ROLLBACK");
  } finally {
    rcClient.release();
  }

  console.log("\n\x1b[32m✔ All hot-path indexes and EXPLAIN plans verified.\x1b[0m\n");
}

main().catch((err) => {
  console.error("\x1b[31m[EXPLAIN ERROR]\x1b[0m", err);
  process.exit(1);
});
