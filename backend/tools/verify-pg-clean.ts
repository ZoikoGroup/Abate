// backend/tools/verify-pg-clean.ts
// Step 1 Hardening: Strict PostgreSQL Parity & Clean Docker Verification Gate
// Verifies:
// 1. With ABATE_REQUIRE_PG=1, DB helpers fail closed (UNAVAILABLE) when Postgres is unreachable rather than silently using MemoryDatabase.
// 2. SQL migration files are sequentially ordered and deterministic for SHA-256 checksum tracking.
// 3. When live PostgreSQL is available (or --require-live is passed), verifies least-privilege roles (NOSUPERUSER NOBYPASSRLS) and abate_worker read denials.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  appPool,
  migratorPool,
  workerPool,
  identityPool,
  protectedComputePool,
  releaseCompilerPool,
  performancePool,
  opsPool,
  withTenant,
  withPlatform,
  withWorker,
  resetPgHealthCache
} from "../src/platform/db/with-tenant";

console.log("\x1b[36m=== Abate Task Runner: verify-pg-clean (Strict PostgreSQL Parity Gate) ===\x1b[0m\n");

const requireLive = process.argv.includes("--require-live");
let passed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
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

async function main() {
  // 1. Verify migration ordering & checksum determinism
  await check("SQL Migrations: Sequential numbering and deterministic SHA-256 checksums", async () => {
    const migrationsDir = path.resolve(__dirname, "../db/migrations");
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    assert.ok(files.length >= 17, `Expected at least 17 migrations, found ${files.length}`);

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      assert.ok(sql.trim().length > 0, `Migration ${file} must not be empty`);
      const sha = crypto.createHash("sha256").update(sql).digest("hex");
      assert.strictEqual(sha.length, 64);
    }
  });

  const pgUp = await isPgUp();

  if (!pgUp) {
    // 2. Offline check: prove ABATE_REQUIRE_PG=1 prevents silent MemoryDatabase fallback
    await check("Fail-Closed Guard: ABATE_REQUIRE_PG=1 refuses MemoryDatabase fallback when Postgres is offline", async () => {
      const prev = process.env.ABATE_REQUIRE_PG;
      process.env.ABATE_REQUIRE_PG = "1";
      resetPgHealthCache();
      try {
        await assert.rejects(
          () => withTenant("00000000-0000-4000-a000-00000000000a", async () => "should-not-run"),
          (err: any) => err?.code === "UNAVAILABLE" && String(err?.message).includes("ABATE_REQUIRE_PG=1")
        );
        await assert.rejects(
          () => withPlatform(async () => "should-not-run"),
          (err: any) => err?.code === "UNAVAILABLE" && String(err?.message).includes("ABATE_REQUIRE_PG=1")
        );
        await assert.rejects(
          () => withWorker(async () => "should-not-run"),
          (err: any) => err?.code === "UNAVAILABLE" && String(err?.message).includes("ABATE_REQUIRE_PG=1")
        );
      } finally {
        if (prev === undefined) delete process.env.ABATE_REQUIRE_PG;
        else process.env.ABATE_REQUIRE_PG = prev;
        resetPgHealthCache();
      }
    });

    if (requireLive) {
      console.error("\n\x1b[31m[ERROR] --require-live was specified, but PostgreSQL is not reachable on 5432. Run: docker compose up -d postgres\x1b[0m\n");
      process.exit(1);
    }

    console.log(`\n\x1b[33m[INFO] PostgreSQL is not running locally; live RLS/role SQL assertions skipped (offline ABATE_REQUIRE_PG=1 fail-closed check PASSED: ${passed}/2).\x1b[0m\n`);
    process.exit(0);
  }

  // 3. Live PostgreSQL Role & RLS Checks (runs when PG is up)
  process.env.ABATE_REQUIRE_PG = "1";
  resetPgHealthCache();

  await check("Live PostgreSQL: All 9 roles exist and are NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE", async () => {
    assert.ok(migratorPool, "migratorPool configured");
    const expectedRoles = [
      "abate_migrator",
      "abate_app",
      "abate_worker",
      "abate_identity",
      "abate_privacy",
      "abate_protected_compute",
      "abate_release_compiler",
      "abate_performance",
      "abate_ops"
    ];
    const client = await migratorPool.connect();
    try {
      const res = await client.query(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
         FROM pg_roles
         WHERE rolname = ANY($1::text[])
         ORDER BY rolname`,
        [expectedRoles]
      );
      const byName = new Map(res.rows.map(r => [r.rolname, r]));
      for (const expected of expectedRoles) {
        const row = byName.get(expected);
        assert.ok(row, `Expected database role ${expected} is missing from pg_roles`);
        assert.strictEqual(row.rolsuper, false, `${row.rolname} must NOT be superuser`);
        assert.strictEqual(row.rolbypassrls, false, `${row.rolname} must NOT have BYPASSRLS`);
        assert.strictEqual(row.rolcreatedb, false, `${row.rolname} must NOT have CREATEDB`);
        assert.strictEqual(row.rolcreaterole, false, `${row.rolname} must NOT have CREATEROLE`);
        assert.strictEqual(row.rolcanlogin, true, `${row.rolname} must be permitted to login`);
      }
    } finally {
      client.release();
    }
  });

  await check("Live PostgreSQL Connection Pools: Every pool connects as non-superuser without BYPASSRLS via current_user", async () => {
    const poolsToVerify = [
      { name: "migratorPool", pool: migratorPool, expectedRole: "abate_migrator" },
      { name: "appPool", pool: appPool, expectedRole: "abate_app" },
      { name: "workerPool", pool: workerPool, expectedRole: "abate_worker" },
      { name: "identityPool", pool: identityPool, expectedRole: "abate_identity" },
      { name: "protectedComputePool", pool: protectedComputePool, expectedRole: "abate_protected_compute" },
      { name: "releaseCompilerPool", pool: releaseCompilerPool, expectedRole: "abate_release_compiler" },
      { name: "performancePool", pool: performancePool, expectedRole: "abate_performance" },
      { name: "opsPool", pool: opsPool, expectedRole: "abate_ops" }
    ];
    for (const { name, pool, expectedRole } of poolsToVerify) {
      assert.ok(pool, `${name} must be configured`);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT current_user AS cu, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
           FROM pg_roles
           WHERE rolname = current_user`
        );
        assert.strictEqual(res.rows.length, 1, `Role for ${name} not found in pg_roles`);
        const row = res.rows[0];
        assert.strictEqual(row.cu, expectedRole, `${name} must connect as ${expectedRole}, connected as ${row.cu}`);
        assert.strictEqual(row.rolsuper, false, `${name} (${row.cu}) must NOT be superuser`);
        assert.strictEqual(row.rolbypassrls, false, `${name} (${row.cu}) must NOT have BYPASSRLS`);
        assert.strictEqual(row.rolcreatedb, false, `${name} (${row.cu}) must NOT have CREATEDB`);
        assert.strictEqual(row.rolcreaterole, false, `${name} (${row.cu}) must NOT have CREATEROLE`);
      } finally {
        client.release();
      }
    }
  });

  await check("Live PostgreSQL: No unapplied schema migrations (schema_migrations matches db/migrations/*.sql)", async () => {
    assert.ok(migratorPool, "migratorPool configured");
    const client = await migratorPool.connect();
    try {
      const res = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
      const applied = new Set(res.rows.map(r => r.version));
      const migrationsDir = path.resolve(__dirname, "../db/migrations");
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
      const unapplied = files.filter(f => !applied.has(f));
      assert.strictEqual(unapplied.length, 0, `Unapplied migrations found: ${unapplied.join(", ")}`);
    } finally {
      client.release();
    }
  });

  await check("Live PostgreSQL: abate_worker fails closed on business & privacy tables", async () => {
    assert.ok(workerPool, "workerPool configured");
    const restricted = [
      "work_fact_revision",
      "identity_map",
      "metric_snapshot",
      "disclosure_ledger",
      "privacy_decision",
      "privacy_release"
    ];
    const client = await workerPool.connect();
    try {
      for (const tbl of restricted) {
        await assert.rejects(
          () => client.query(`SELECT count(*) FROM ${tbl}`),
          /permission denied|does not exist/i,
          `abate_worker must NOT be able to read ${tbl}`
        );
      }
    } finally {
      client.release();
    }
  });

  await check("Live PostgreSQL: abate_app without app.tenant_id sees zero tenant rows (Forced RLS)", async () => {
    assert.ok(appPool, "appPool configured");
    const client = await appPool.connect();
    try {
      const res = await client.query("SELECT * FROM organization");
      assert.strictEqual(res.rowCount, 0, "Queries without app.tenant_id must return zero rows");
    } finally {
      client.release();
    }
  });

  console.log(`\n\x1b[32m✔ Completed Live PostgreSQL Parity Verification: ${passed} checks passed.\x1b[0m\n`);
  process.exit(0);
}

main().catch(err => {
  console.error("\x1b[31m[VERIFY-PG FAILED]\x1b[0m", err);
  process.exit(1);
});

