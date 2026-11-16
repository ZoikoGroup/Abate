// backend/tools/measure-pg-restore.ts
// Real PostgreSQL Backup/Restore RTO & Anti-Resurrection Timing Runner (Stage B)
// Fails closed unless live PostgreSQL (DATABASE_URL_MIGRATOR + pg_dump + pg_restore) is reachable.
// Records real wall-clock dump/restore + tombstone reconciliation timing into evidence/pg-restore-measurement.json.

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { requestErasure } from "../src/domains/lifecycle";
import { seedTwoTenants } from "../src/fixtures/seed";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`${name} is required for live PostgreSQL restore timing.`);
  }
  return val;
}

async function main() {
  console.log("\x1b[36m=== Abate Task Runner: measure-pg-restore (Live PG RTO & Resurrection Timing) ===\x1b[0m");

  const migratorUrl = requireEnv("DATABASE_URL_MIGRATOR");
  const pool = new Pool({ connectionString: migratorUrl });
  const tempDump = path.join(os.tmpdir(), `abate-restore-drill-${Date.now()}.dump`);

  try {
    await pool.query("SELECT 1");
    await seedTwoTenants({ persistToPostgres: true });

    const tenantA = GOLDEN_01.tenantA.id;
    const probeSubject = `restore-probe-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Insert probe receipt + work fact & obtain external pre-erasure snapshot
    const connId = "00000000-0000-4000-a004-000000000001";
    const receiptId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    const recordId = `restore-rec-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO ingest_receipt (id, tenant_id, connection_id, batch_id, accepted, duplicate, rejected, conflicted)
       VALUES ($1, $2, $3, $4, 1, 0, 0, 0)`,
      [receiptId, tenantA, connId, `restore-batch-${crypto.randomUUID().slice(0, 8)}`]
    );
    await pool.query(
      `INSERT INTO work_fact_revision (id, tenant_id, connection_id, receipt_id, source_record_id, revision, subject_pseudonym, kind, start_at, end_at, work_tz, payload_hash)
       VALUES ($1, $2, $3, $4, $5, 1, $6, 'WORK', '2026-03-02T09:00:00Z', '2026-03-02T17:00:00Z', 'Europe/London', 'sha256-probe')`,
      [factId, tenantA, connId, receiptId, recordId, probeSubject]
    );

    const dumpStart = Date.now();
    execFileSync("pg_dump", ["-Fc", "-f", tempDump, migratorUrl], { stdio: "pipe" });
    const dumpMs = Date.now() - dumpStart;

    // 2. Execute GDPR erasure (writes durable deletion_tombstone and purges work_fact_revision)
    const erasureRes = await requestErasure({
      tenantId: tenantA,
      actorPrincipalId: "00000000-0000-4000-a002-000000000001",
      subjectPseudonym: probeSubject,
      basis: "GDPR_ART_17"
    });
    assert.strictEqual(erasureRes.purgedCount, 1, "Expected 1 probe work fact purged before restore");

    const tombSnap = await pool.query(
      `SELECT id, tenant_id, data_category, record_key_digest, subject_digest, tombstone_hash, erased_at
       FROM deletion_tombstone WHERE tenant_id = $1`,
      [tenantA]
    );

    // 3. Restore stale pre-erasure backup into isolated scratch database and re-apply tombstone reconciliation
    const baseUrl = new URL(migratorUrl);
    const scratchDb = `abate_restore_drill_${Date.now()}`;
    const adminUrl = new URL(migratorUrl);
    adminUrl.pathname = "/postgres";

    const rtoStart = Date.now();
    const adminPool = new Pool({ connectionString: adminUrl.toString() });
    try {
      await adminPool.query(`CREATE DATABASE ${scratchDb}`);
      const scratchUrl = new URL(migratorUrl);
      scratchUrl.pathname = `/${scratchDb}`;

      execFileSync("pg_restore", ["--clean", "--if-exists", "-d", scratchUrl.toString(), tempDump], { stdio: "pipe" });

      // Reconcile restored state against external tombstone ledger
      const scratchPool = new Pool({ connectionString: scratchUrl.toString() });
      try {
        for (const t of tombSnap.rows) {
          await scratchPool.query(
            `DELETE FROM work_fact_revision WHERE tenant_id = $1 AND encode(sha256(convert_to(source_record_id || ':' || subject_pseudonym, 'utf8')), 'hex') = $2`,
            [t.tenant_id, t.record_key_digest]
          );
          await scratchPool.query(
            `INSERT INTO deletion_tombstone (id, tenant_id, data_category, record_key_digest, subject_digest, tombstone_hash, erased_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
            [t.id, t.tenant_id, t.data_category, t.record_key_digest, t.subject_digest, t.tombstone_hash, t.erased_at]
          );
        }

        const surviving = await scratchPool.query(
          `SELECT COUNT(*)::int AS cnt FROM work_fact_revision WHERE tenant_id = $1 AND source_record_id = $2`,
          [tenantA, recordId]
        );
        const resurrectedCount = surviving.rows[0]?.cnt ?? 0;
        assert.strictEqual(resurrectedCount, 0, "Deleted probe record resurrected after PostgreSQL restore!");

        const rtoMs = Date.now() - rtoStart;
        const report = {
          schema: "abate.pg-restore-measurement.v1",
          generatedAt: new Date().toISOString(),
          databaseHost: baseUrl.hostname,
          dumpDurationMs: dumpMs,
          restorePlusReconciliationRtoMs: rtoMs,
          tombstonesReconciled: tombSnap.rowCount ?? 0,
          resurrectedRecords: resurrectedCount,
          passed: true
        };

        const outPath = path.resolve(__dirname, "../../evidence/pg-restore-measurement.json");
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

        console.log(`  ✔ Dump completed in ${dumpMs}ms; Restore + Tombstone reconciliation RTO = ${rtoMs}ms (0 resurrected)`);
      } finally {
        await scratchPool.end();
      }
    } finally {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchDb}`).catch(() => {});
      await adminPool.end();
    }
  } finally {
    if (fs.existsSync(tempDump)) fs.unlinkSync(tempDump);
    await pool.end();
  }
}

main().catch((err) => {
  const msg =
    err?.message ||
    (Array.isArray(err?.errors) ? err.errors.map((e: any) => e?.message || e?.code).join("; ") : "") ||
    err?.code ||
    String(err);
  console.error(`\x1b[31m[PG RESTORE DRILL FAILED]\x1b[0m ${msg}`);
  process.exit(1);
});
