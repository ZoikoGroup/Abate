// backend/tools/db-audit.ts
// Completion Plan Section 5.3 / G-23 / T-10:
// Runs the five catalog queries from docs/db-audit.sql against live PostgreSQL
// and fails CI on any returned violation row.
// When PostgreSQL is offline (and --require-live is not set), performs a static
// migration audit for FORCE ROW LEVEL SECURITY and immutability triggers.

import fs from "node:fs";
import path from "node:path";
import { migratorPool } from "../src/platform/db/with-tenant";

const requireLive = process.argv.includes("--require-live");

interface AuditQuery {
  name: string;
  sql: string;
}

const AUDIT_QUERIES: AuditQuery[] = [
  {
    name: "1. Tenant tables without ENABLE + FORCE ROW LEVEL SECURITY",
    sql: `
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns k
          WHERE k.table_schema = 'public'
            AND k.table_name = c.relname
            AND k.column_name = 'tenant_id'
        )
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    `
  },
  {
    name: "2. Dangerous role attributes on runtime roles (abate_* except abate_migrator)",
    sql: `
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      FROM pg_roles
      WHERE rolname LIKE 'abate_%'
        AND rolname <> 'abate_migrator'
        AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
    `
  },
  {
    name: "3. Tables owned by runtime roles",
    sql: `
      SELECT tablename, tableowner
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tableowner IN (
          'abate_app',
          'abate_worker',
          'abate_protected_compute',
          'abate_release_compiler',
          'abate_performance',
          'abate_ops',
          'abate_privacy',
          'abate_identity'
        )
    `
  },
  {
    name: "4. Web role (abate_app) grants on protected tables",
    sql: `
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'abate_app'
        AND table_name IN ('metric_snapshot', 'disclosure_ledger', 'identity_map')
    `
  },
  {
    name: "5. RLS-enabled tables with no policy",
    sql: `
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity
        AND NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public'
            AND p.tablename = c.relname
        )
    `
  }
];

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

function runStaticMigrationAudit(): void {
  const migrationsDir = path.resolve(__dirname, "../db/migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const combined = files.map((f) => fs.readFileSync(path.join(migrationsDir, f), "utf-8")).join("\n");

  const requiredPatterns: Array<{ label: string; re: RegExp }> = [
    { label: "audit_event_immutable trigger", re: /CREATE TRIGGER audit_event_immutable/i },
    { label: "metric_definition_immutable_guard trigger", re: /CREATE TRIGGER metric_definition_immutable_guard/i },
    { label: "REVOKE ALL ON metric_snapshot FROM abate_app", re: /REVOKE ALL ON metric_snapshot FROM abate_app/i },
    { label: "REVOKE ALL ON disclosure_ledger FROM abate_app", re: /REVOKE ALL ON disclosure_ledger FROM abate_app/i },
    { label: "REVOKE ALL ON identity_map FROM abate_app", re: /REVOKE ALL ON identity_map FROM abate_app/i },
    { label: "evidence_item_tenant_isolation policy", re: /CREATE POLICY evidence_item_tenant_isolation ON evidence_item/i },
    { label: "tenant_sector_setting FORCE RLS", re: /ALTER TABLE tenant_sector_setting FORCE ROW LEVEL SECURITY/i }
  ];

  let failures = 0;
  for (const p of requiredPatterns) {
    if (!p.re.test(combined)) {
      console.error(`  ✖ Static migration audit missing: ${p.label}`);
      failures++;
    } else {
      console.log(`  ✔ Static migration audit verified: ${p.label}`);
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
}

async function main() {
  console.log("\x1b[36m=== Abate Database Integrity Catalog Audit (docs/db-audit.sql) ===\x1b[0m\n");

  const pgUp = await isPgUp();
  if (!pgUp) {
    if (requireLive) {
      console.error("\x1b[31m[DB-AUDIT FAILED]\x1b[0m --require-live specified, but PostgreSQL is not reachable.");
      process.exit(1);
    }
    console.log("\x1b[33m[INFO] PostgreSQL not reachable locally; running static SQL migration audit...\x1b[0m\n");
    runStaticMigrationAudit();
    console.log("\n\x1b[32m✔ Static DB audit passed. Run with --require-live against PostgreSQL in CI.\x1b[0m\n");
    process.exit(0);
  }

  const client = await migratorPool!.connect();
  let violations = 0;
  try {
    for (const q of AUDIT_QUERIES) {
      const res = await client.query(q.sql);
      if ((res.rowCount ?? 0) > 0) {
        violations += res.rowCount ?? 0;
        console.error(`  \x1b[31m✖\x1b[0m ${q.name}: returned ${res.rowCount} violation row(s):`);
        console.error(JSON.stringify(res.rows, null, 2));
      } else {
        console.log(`  \x1b[32m✔\x1b[0m ${q.name}: 0 rows`);
      }
    }

    // Verify all 7 Section 5.1 roles (+ abate_identity) exist
    const expectedRoles = [
      "abate_migrator",
      "abate_app",
      "abate_worker",
      "abate_protected_compute",
      "abate_release_compiler",
      "abate_performance",
      "abate_ops",
      "abate_identity"
    ];
    const rolesRes = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`,
      [expectedRoles]
    );
    const present = new Set(rolesRes.rows.map((r) => r.rolname));
    const missing = expectedRoles.filter((r) => !present.has(r));
    if (missing.length > 0) {
      violations += missing.length;
      console.error(`  \x1b[31m✖\x1b[0m Missing Section 5.1 roles: ${missing.join(", ")}`);
    } else {
      console.log(`  \x1b[32m✔\x1b[0m All Section 5.1 roles present (${expectedRoles.length}/${expectedRoles.length})`);
    }
  } finally {
    client.release();
  }

  if (violations > 0) {
    console.error(`\n\x1b[31m[DB-AUDIT FAILED]\x1b[0m ${violations} violation(s) found.\n`);
    process.exit(1);
  }

  console.log("\n\x1b[32m✔ Live PostgreSQL DB audit passed (0 violations).\x1b[0m\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[DB-AUDIT ERROR]\x1b[0m", err);
  process.exit(1);
});
