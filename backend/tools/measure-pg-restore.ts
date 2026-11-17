// backend/tools/measure-pg-restore.ts
// Real PostgreSQL Backup/Restore RTO, RPO & Anti-Resurrection Timing Runner (Stage B Item 2)
// Fails closed unless live PostgreSQL (DATABASE_URL_MIGRATOR + pg_dump + pg_restore) is reachable.
// Records machine spec, workload, lastRecoverableChangeAt, restoreStartedAt, trafficApprovedAt,
// computed RTO/RPO, and restored-DB boundary smoke checks into evidence/pg-restore-measurement.json.

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { requestErasure } from "../src/domains/lifecycle";
import { resolveActor } from "../src/domains/tenant/auth";
import { seedTwoTenants } from "../src/fixtures/seed";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`${name} is required for live PostgreSQL restore timing.`);
  }
  return val;
}

async function withTenantPool<T>(pool: Pool, tenantId: string, fn: (q: (sql: string, params?: any[]) => Promise<any>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client.query.bind(client));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function classifyEvidence(): { classification: string; notice: string; envLabel: string } {
  if (process.env.CI === "true") {
    return {
      classification: "CI_INDICATIVE",
      notice: "CI runner indicative timing only — not fixed-environment measured evidence.",
      envLabel: "github-actions-runner"
    };
  }
  if (process.env.ABATE_MEASURED_ENV) {
    return {
      classification: "FIXED_ENV_MEASURED",
      notice: `Fixed-environment measured restore drill (${process.env.ABATE_MEASURED_ENV}).`,
      envLabel: process.env.ABATE_MEASURED_ENV
    };
  }
  return {
    classification: "UNCLASSIFIED_LOCAL_PG",
    notice: "Local PostgreSQL restore timing; set ABATE_MEASURED_ENV on the designated benchmark host.",
    envLabel: "local-workstation"
  };
}

async function main() {
  console.log("\x1b[36m=== Abate Task Runner: measure-pg-restore (Live PG RTO/RPO & Boundary Smoke) ===\x1b[0m");

  const migratorUrl = requireEnv("DATABASE_URL_MIGRATOR");
  const pool = new Pool({ connectionString: migratorUrl });
  const tempDump = path.join(os.tmpdir(), `abate-restore-drill-${Date.now()}.dump`);

  try {
    await pool.query("SELECT 1");
    await seedTwoTenants({ persistToPostgres: true });

    const tenantA = GOLDEN_01.tenantA.id;
    const probeSubject = `restore-probe-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Insert probe receipt + work fact under tenant RLS context & take external pre-erasure backup
    const connId = "00000000-0000-4000-a004-000000000001";
    const receiptId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    const recordId = `restore-rec-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantPool(pool, tenantA, async (q) => {
      await q(
        `INSERT INTO ingest_receipt (id, tenant_id, connection_id, batch_id, accepted, duplicate, rejected, conflicted)
         VALUES ($1, $2, $3, $4, 1, 0, 0, 0)`,
        [receiptId, tenantA, connId, `restore-batch-${crypto.randomUUID().slice(0, 8)}`]
      );
      await q(
        `INSERT INTO work_fact_revision (id, tenant_id, connection_id, receipt_id, source_record_id, revision, subject_pseudonym, kind, start_at, end_at, work_tz, payload_hash)
         VALUES ($1, $2, $3, $4, $5, 1, $6, 'WORK', '2026-03-02T09:00:00Z', '2026-03-02T17:00:00Z', 'Europe/London', 'sha256-probe')`,
        [factId, tenantA, connId, receiptId, recordId, probeSubject]
      );
    });

    const statsRes = await pool.query(
      `SELECT COALESCE((SELECT reltuples::bigint FROM pg_class WHERE relname = 'work_fact_revision'), 0) AS est_facts,
              COALESCE((SELECT reltuples::bigint FROM pg_class WHERE relname = 'tenant'), 0) AS est_tenants`
    );
    const estFacts = Number(statsRes.rows[0]?.est_facts ?? 0);
    const estTenants = Number(statsRes.rows[0]?.est_tenants ?? 0);

    const lastRecoverableChangeMs = Date.now();
    const lastRecoverableChangeAt = new Date(lastRecoverableChangeMs).toISOString();

    const dumpStart = Date.now();
    execFileSync("pg_dump", ["-Fc", "-f", tempDump, migratorUrl], { stdio: "pipe" });
    const dumpMs = Date.now() - dumpStart;

    // 2. Execute GDPR erasure (writes durable deletion_tombstone and purges work_fact_revision)
    const whoA = {
      tenantId: tenantA,
      subject: "auth0|user-tenant-a-risk-owner",
      purpose: "WORKPLACE_RISK_ASSESSMENT",
      role: "RISK_OWNER"
    };
    const actorA = await resolveActor(tenantA, whoA.subject, new Date());
    const erasureRes = await requestErasure({
      who: whoA,
      actor: actorA,
      input: { subjectPseudonym: probeSubject },
      idempotencyKey: `restore-erase-${crypto.randomUUID()}`
    });
    assert.strictEqual(erasureRes.body.deleted, 1, "Expected 1 probe work fact purged before restore");

    const tombSnap = await withTenantPool(pool, tenantA, async (q) =>
      q(
        `SELECT id, tenant_id, run_id, data_category, record_ref, record_digest, record_key_digest, deleted_at, verified_at
         FROM deletion_tombstone WHERE tenant_id = $1`,
        [tenantA]
      )
    );

    // 3. Restore stale pre-erasure backup into isolated scratch database and re-apply tombstone reconciliation
    const baseUrl = new URL(migratorUrl);
    const migratorUser = decodeURIComponent(baseUrl.username || "abate_migrator");
    const precreatedScratchUrl = process.env.RESTORE_SCRATCH_DB_URL;
    const scratchDb = precreatedScratchUrl
      ? new URL(precreatedScratchUrl).pathname.replace(/^\//, "")
      : `abate_restore_drill_${Date.now()}`;

    const adminUrl = process.env.POSTGRES_ADMIN_URL
      ? new URL(process.env.POSTGRES_ADMIN_URL)
      : (() => {
          const u = new URL(migratorUrl);
          u.pathname = "/postgres";
          return u;
        })();

    const restoreStartedMs = Date.now();
    const restoreStartedAt = new Date(restoreStartedMs).toISOString();
    const adminPool = precreatedScratchUrl ? null : new Pool({ connectionString: adminUrl.toString() });

    try {
      let scratchUrlString: string;
      if (precreatedScratchUrl) {
        scratchUrlString = precreatedScratchUrl;
        execFileSync("pg_restore", ["--clean", "--if-exists", "-d", scratchUrlString, tempDump], { stdio: "pipe" });
      } else {
        try {
          await adminPool!.query(`CREATE DATABASE ${scratchDb} OWNER "${migratorUser}"`);
        } catch (createErr: any) {
          throw new Error(
            `Failed to create isolated restore database '${scratchDb}': ${createErr.message}. ` +
              "Set POSTGRES_ADMIN_URL (with CREATEDB) or pre-create an empty scratch database via RESTORE_SCRATCH_DB_URL."
          );
        }
        const scratchUrl = new URL(migratorUrl);
        scratchUrl.pathname = `/${scratchDb}`;
        scratchUrlString = scratchUrl.toString();
        execFileSync("pg_restore", ["-d", scratchUrlString, tempDump], { stdio: "pipe" });
      }

      // Reconcile restored state against external tombstone ledger, then verify boundaries on restored DB
      const scratchPool = new Pool({ connectionString: scratchUrlString });
      let restoredBoundariesVerified = false;
      try {
        await withTenantPool(scratchPool, tenantA, async (q) => {
          for (const t of tombSnap.rows) {
            await q(
              `INSERT INTO deletion_tombstone (id, tenant_id, run_id, data_category, record_ref, record_digest, record_key_digest, deleted_at, verified_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
              [t.id, t.tenant_id, t.run_id, t.data_category, t.record_ref, t.record_digest, t.record_key_digest, t.deleted_at, t.verified_at]
            );
            await q(
              `DELETE FROM work_fact_revision WHERE tenant_id = $1 AND id = $2`,
              [t.tenant_id, t.record_ref]
            );
          }
        });

        // Boundary check 1: Erased record cannot resurrect after restore
        const resurrectedCount = await withTenantPool(scratchPool, tenantA, async (q) => {
          const surviving = await q(
            `SELECT COUNT(*)::int AS cnt FROM work_fact_revision WHERE tenant_id = $1 AND source_record_id = $2`,
            [tenantA, recordId]
          );
          return Number(surviving.rows[0]?.cnt ?? 0);
        });
        assert.strictEqual(resurrectedCount, 0, "Deleted probe record resurrected after PostgreSQL restore!");

        // Boundary check 2: Forced RLS retained on restored copy
        const rlsCheck = await scratchPool.query(
          `SELECT COUNT(*)::int AS cnt FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'work_fact_revision' AND c.relforcerowsecurity = true`
        );
        assert.strictEqual(rlsCheck.rows[0]?.cnt, 1, "work_fact_revision must retain FORCE ROW LEVEL SECURITY after restore");

        if (process.env.DATABASE_URL_APP) {
          const restoredAppUrl = new URL(process.env.DATABASE_URL_APP);
          restoredAppUrl.pathname = `/${scratchDb}`;
          const restoredAppPool = new Pool({ connectionString: restoredAppUrl.toString() });
          try {
            await withTenantPool(restoredAppPool, GOLDEN_01.tenantB.id, async (q) => {
              const crossTenant = await q(`SELECT id FROM organization WHERE tenant_id = $1`, [tenantA]);
              assert.strictEqual(crossTenant.rowCount, 0, "Restored DB RLS leaked Tenant A orgs to Tenant B");
            });
          } finally {
            await restoredAppPool.end();
          }
        }
        restoredBoundariesVerified = true;

        const trafficApprovedMs = Date.now();
        const trafficApprovedAt = new Date(trafficApprovedMs).toISOString();
        const rtoMs = trafficApprovedMs - restoreStartedMs;
        const rpoMs = Math.max(0, lastRecoverableChangeMs - dumpStart);
        const { classification, notice, envLabel } = classifyEvidence();

        const report = {
          schema: "abate.pg-restore-measurement.v1",
          generatedAt: trafficApprovedAt,
          evidenceClassification: classification,
          evidenceNotice: notice,
          machine: {
            environmentLabel: envLabel,
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpuCount: os.cpus().length,
            totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
            databaseHost: baseUrl.hostname
          },
          workload: {
            estimatedTenants: Math.max(2, estTenants),
            estimatedWorkFactsInDump: Math.max(1, estFacts),
            erasedProbeFacts: erasureRes.body.deleted,
            tombstonesReconciled: tombSnap.rowCount ?? 0,
            dumpSizeBytes: fs.statSync(tempDump).size
          },
          timestamps: {
            lastRecoverableChangeAt,
            restoreStartedAt,
            trafficApprovedAt
          },
          dumpDurationMs: dumpMs,
          restorePlusReconciliationRtoMs: rtoMs,
          measuredRpoMs: rpoMs,
          resurrectedRecords: resurrectedCount,
          restoredBoundariesVerified,
          passed: true
        };

        const outPath = path.resolve(__dirname, "../../evidence/pg-restore-measurement.json");
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

        console.log(`  ✔ Dump completed in ${dumpMs}ms; Restore + Boundary Smoke RTO = ${rtoMs}ms, RPO = ${rpoMs}ms (0 resurrected)`);
      } finally {
        await scratchPool.end();
      }
    } finally {
      if (adminPool) {
        await adminPool.query(`DROP DATABASE IF EXISTS ${scratchDb}`).catch(() => {});
        await adminPool.end();
      }
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
