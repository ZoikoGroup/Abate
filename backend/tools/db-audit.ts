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
    name: "2. Dangerous role attributes on all abate_* roles (including abate_migrator)",
    sql: `
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      FROM pg_roles
      WHERE rolname LIKE 'abate_%'
        AND rolname <> 'abate_admin'
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
  },
  {
    name: "6. Published outbox prune DELETE grant missing on outbox_event (0089)",
    sql: `
      SELECT expected_role
      FROM unnest(ARRAY['abate_worker', 'abate_ops']) AS expected_role
      WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.role_table_grants g
        WHERE g.grantee = expected_role
          AND g.table_schema = 'public'
          AND g.table_name = 'outbox_event'
          AND g.privilege_type = 'DELETE'
      )
    `
  },
  {
    name: "7. Published outbox prune DELETE RLS policies missing on outbox_event (0089)",
    sql: `
      SELECT expected_policy
      FROM unnest(ARRAY['worker_prune_published', 'ops_prune_published']) AS expected_policy
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = 'outbox_event'
          AND p.policyname = expected_policy
          AND p.cmd = 'DELETE'
      )
    `
  },
  {
    name: "8. abate_migrator retains read policy on tenant or connection (0091 must drop 0090 read policies)",
    sql: `
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('tenant', 'connection')
        AND 'abate_migrator' = ANY(roles)
        AND cmd IN ('SELECT', 'ALL')
    `
  },
  {
    name: "9. Ops views missing security_invoker=true option (0091)",
    sql: `
      SELECT c.relname AS view_name, c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'v'
        AND c.relname IN ('ops_active_tenants', 'ops_connector_health')
        AND (c.reloptions IS NULL OR NOT ('security_invoker=true' = ANY(c.reloptions)))
    `
  },
  {
    name: "10. Unexpected table-level or unapproved column-level grants on tenant/connection for abate_ops or abate_worker (0091/0092)",
    sql: `
      SELECT grantee, table_name, privilege_type, NULL::text AS column_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND (
          (table_name = 'connection' AND grantee IN ('abate_ops', 'abate_worker')) OR
          (table_name = 'tenant' AND grantee = 'abate_worker')
        )
      UNION ALL
      SELECT grantee, table_name, privilege_type, column_name
      FROM information_schema.role_column_grants
      WHERE table_schema = 'public'
        AND table_name = 'tenant'
        AND grantee = 'abate_worker'
        AND (privilege_type <> 'SELECT' OR column_name NOT IN ('id', 'region'))
      UNION ALL
      SELECT grantee, table_name, privilege_type, column_name
      FROM information_schema.role_column_grants
      WHERE table_schema = 'public'
        AND table_name = 'tenant'
        AND grantee = 'abate_ops'
        AND column_name NOT IN ('id', 'name', 'region', 'jurisdiction_config_ref', 'state', 'created_at')
      UNION ALL
      SELECT grantee, table_name, privilege_type, column_name
      FROM information_schema.role_column_grants
      WHERE table_schema = 'public'
        AND table_name = 'connection'
        AND (
          (grantee = 'abate_worker') OR
          (grantee = 'abate_ops' AND (privilege_type <> 'SELECT' OR column_name NOT IN ('id', 'source', 'state', 'last_success_at', 'expected_cadence_seconds')))
        )
    `
  },
  {
    name: "11. Missing required narrow column grants on tenant/connection for ops views (0091)",
    sql: `
      SELECT expected.grantee, expected.table_name, expected.column_name
      FROM (VALUES
        ('abate_ops', 'tenant', 'id'),
        ('abate_ops', 'tenant', 'region'),
        ('abate_worker', 'tenant', 'id'),
        ('abate_worker', 'tenant', 'region'),
        ('abate_ops', 'connection', 'id'),
        ('abate_ops', 'connection', 'source'),
        ('abate_ops', 'connection', 'state'),
        ('abate_ops', 'connection', 'last_success_at'),
        ('abate_ops', 'connection', 'expected_cadence_seconds')
      ) AS expected(grantee, table_name, column_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.role_column_grants g
        WHERE g.table_schema = 'public'
          AND g.grantee = expected.grantee
          AND g.table_name = expected.table_name
          AND g.column_name = expected.column_name
          AND g.privilege_type = 'SELECT'
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
    { label: "tenant_sector_setting FORCE RLS", re: /ALTER TABLE tenant_sector_setting FORCE ROW LEVEL SECURITY/i },
    { label: "async_job FORCE RLS", re: /ALTER TABLE async_job FORCE ROW LEVEL SECURITY/i },
    { label: "ops_active_tenants view", re: /CREATE OR REPLACE VIEW ops_active_tenants/i },
    { label: "ops_connector_health view", re: /CREATE OR REPLACE VIEW ops_connector_health/i },
    { label: "worker_consumer_version table", re: /CREATE TABLE IF NOT EXISTS worker_consumer_version/i },
    { label: "worker_prune_published policy (0089)", re: /CREATE POLICY worker_prune_published ON outbox_event FOR DELETE TO abate_worker/i },
    { label: "ops_prune_published policy (0089)", re: /CREATE POLICY ops_prune_published ON outbox_event FOR DELETE TO abate_ops/i },
    { label: "ops_active_tenants security_invoker (0091)", re: /ALTER VIEW ops_active_tenants SET \(security_invoker = true\)/i },
    { label: "ops_connector_health security_invoker (0091)", re: /ALTER VIEW ops_connector_health SET \(security_invoker = true\)/i },
    { label: "tenant_ops_active_view_read policy (0091)", re: /CREATE POLICY tenant_ops_active_view_read ON tenant/i },
    { label: "connection_ops_health_view_read policy (0091)", re: /CREATE POLICY connection_ops_health_view_read ON connection/i }
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
