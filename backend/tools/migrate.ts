// backend/tools/migrate.ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { migratorPool } from "../src/platform/db/with-tenant";

console.log("\x1b[36m=== Abate Task Runner: migrate ===\x1b[0m");

const migrationsDir = path.resolve(__dirname, "../db/migrations");
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

console.log(`Found ${files.length} ordered migration files.`);

async function runMigrations() {
  if (!migratorPool) {
    throw new Error("PostgreSQL migrator pool is not configured.");
  }

  const client = await migratorPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('abate-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const result = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file]
      );

      if (result.rowCount) {
        if (result.rows[0].checksum !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied.`);
        }
        console.log(`  Skipping [already applied]: ${file}`);
        continue;
      }

      console.log(`  Applying [PG Migrator Role]: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("\x1b[32m[SUCCESS] All SQL migrations applied to PostgreSQL.\x1b[0m");
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('abate-schema-migrations'))");
    } catch (error) {
      console.error(
        "\x1b[33m[MIGRATION WARNING]\x1b[0m Could not release migration lock:",
        error instanceof Error ? error.message : error
      );
    }
    client.release();
  }
}

runMigrations().catch(err => {
  console.error("\x1b[31m[MIGRATION ERROR]\x1b[0m", err instanceof Error ? err.message : err);
  process.exit(1);
});
