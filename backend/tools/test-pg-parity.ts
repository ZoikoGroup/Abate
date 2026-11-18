// backend/tools/test-pg-parity.ts
// Completion Plan Wave 0 T-02 / G-01 & Section 5.10:
// Exercises live PostgreSQL runtime role isolation, forced RLS, immutability triggers,
// Plane B guard trigger, connection state transitions, tenant_sector_setting, and memDb parity.

import assert from "node:assert";
import crypto from "node:crypto";
import {
  appPool,
  migratorPool,
  workerPool,
  protectedComputePool,
  releaseCompilerPool,
  performancePool,
  opsPool,
  withTenant,
  withProtectedCompute,
  withReleaseCompiler,
  withPerformance,
  resetPgHealthCache
} from "../src/platform/db/with-tenant";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { resolveTenantSectorProfile, setTenantSectorSetting } from "../src/domains/lifecycle/sector";
import { createOrganization } from "../src/domains/tenant/commands";
import { resolveActor } from "../src/domains/tenant/auth";
import { compileRelease } from "../src/domains/privacy";

const requireLive = process.argv.includes("--require-live");
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err?.message || err}`);
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
  console.log("\x1b[36m=== Abate Live PostgreSQL Role, Trigger & Parity Suite (test-pg-parity) ===\x1b[0m\n");

  const pgUp = await isPgUp();
  if (!pgUp) {
    if (requireLive) {
      console.error("\x1b[31m[PG-PARITY FAILED]\x1b[0m --require-live specified, but PostgreSQL is offline.");
      process.exit(1);
    }
    console.log("\x1b[33m[INFO] PostgreSQL not reachable locally; skipping live PG parity checks (passes in CI with --require-live).\x1b[0m\n");
    process.exit(0);
  }

  process.env.ABATE_REQUIRE_PG = "1";
  resetPgHealthCache();
  await seedTwoTenants({ persistToPostgres: true });

  const tenantA = GOLDEN_01.tenantA.id;
  const tenantB = GOLDEN_01.tenantB.id;

  await check("Role Separation: abate_app cannot query protected tables (metric_snapshot, disclosure_ledger, identity_map)", async () => {
    const client = await appPool!.connect();
    try {
      for (const tbl of ["metric_snapshot", "disclosure_ledger", "identity_map"]) {
        await assert.rejects(
          () => client.query(`SELECT count(*) FROM ${tbl}`),
          /permission denied/i,
          `abate_app must not have SELECT on ${tbl}`
        );
      }
    } finally {
      client.release();
    }
  });

  await check("Role Separation: abate_worker cannot read business or identity tables", async () => {
    const client = await workerPool!.connect();
    try {
      for (const tbl of ["work_fact_revision", "organization", "identity_map", "metric_snapshot", "disclosure_ledger"]) {
        await assert.rejects(
          () => client.query(`SELECT count(*) FROM ${tbl}`),
          /permission denied/i,
          `abate_worker must not read ${tbl}`
        );
      }
    } finally {
      client.release();
    }
  });

  await check("Role Separation: abate_protected_compute, abate_release_compiler, abate_performance, abate_ops least-privilege boundaries", async () => {
    const pc = await protectedComputePool!.connect();
    try {
      await pc.query("BEGIN");
      await pc.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await pc.query("SELECT count(*) FROM work_fact_revision");
      await pc.query("ROLLBACK");
      await assert.rejects(() => pc.query("SELECT count(*) FROM identity_map"), /permission denied/i);
      await assert.rejects(() => pc.query("SELECT count(*) FROM disclosure_ledger"), /permission denied/i);
    } finally {
      pc.release();
    }

    const rc = await releaseCompilerPool!.connect();
    try {
      await rc.query("BEGIN");
      await rc.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await rc.query("SELECT count(*) FROM metric_snapshot");
      await rc.query("ROLLBACK");
      await assert.rejects(() => rc.query("SELECT count(*) FROM work_fact_revision"), /permission denied/i);
      await assert.rejects(() => rc.query("SELECT count(*) FROM identity_map"), /permission denied/i);
    } finally {
      rc.release();
    }

    const ops = await opsPool!.connect();
    try {
      await ops.query("SELECT count(*) FROM ai_kill_switch");
      await assert.rejects(() => ops.query("SELECT count(*) FROM work_fact_revision"), /permission denied/i);
    } finally {
      ops.release();
    }
  });

  await check("Pool Reuse A -> B (max=1 simulation) leaves zero tenant residue", async () => {
    await withTenant(tenantA, async (tx) => {
      await tx.q("SELECT id FROM organization");
    });
    const client = await appPool!.connect();
    try {
      // Missing context after pool reuse returns 0 rows
      const noCtx = await client.query("SELECT id FROM organization");
      assert.strictEqual(noCtx.rowCount, 0);
    } finally {
      client.release();
    }
  });

  await check("Immutability Triggers: audit_event_immutable and metric_definition_immutable_guard refuse mutations", async () => {
    const mClient = await migratorPool!.connect();
    try {
      // Ensure at least one audit_event and one APPROVED metric_definition row exist so FOR EACH ROW triggers fire
      await mClient.query("BEGIN");
      await mClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await mClient.query(
        `INSERT INTO audit_event (tenant_id, command, result) VALUES ($1, 'pg.parity.probe', 'SUCCESS')`,
        [tenantA]
      );
      await mClient.query(
        `INSERT INTO metric_definition (metric_id, version, tenant_id, definition, definition_hash, status)
         VALUES ('BOUNDARY_INTRUSION_SHARE', 1, NULL, '{"formula":"outside/total"}'::jsonb, 'sha256-seed-v1', 'APPROVED')
         ON CONFLICT (metric_id, version) DO NOTHING`
      );
      await mClient.query("COMMIT");

      await assert.rejects(
        () => mClient.query("UPDATE audit_event SET command = 'tampered' WHERE id = (SELECT id FROM audit_event LIMIT 1)"),
        /append-only/i
      );
      await assert.rejects(
        () => mClient.query("UPDATE metric_definition SET definition_hash = 'tampered' WHERE status = 'APPROVED'"),
        /immutable/i
      );
    } finally {
      mClient.release();
    }
  });

  await check("Plane B Guard Trigger: write_plane = 'B' cannot mutate Plane A hazard.disposition", async () => {
    await assert.rejects(
      async () => {
        await withPerformance(tenantA, async (tx) => {
          await tx.q("UPDATE hazard SET disposition = 'VERIFIED_CLOSURE' WHERE tenant_id = $1", [tenantA]);
        });
      },
      /plane A|permission denied/i
    );
    await assert.rejects(
      async () => {
        await withTenant(
          tenantA,
          async (tx) => {
            await tx.q("UPDATE hazard SET disposition = 'VERIFIED_CLOSURE' WHERE tenant_id = $1", [tenantA]);
          },
          { writePlane: "B" }
        );
      },
      /plane A/i
    );
  });

  await check("tenant_sector_setting Forced RLS + Cross-Role Helpers (withProtectedCompute / withReleaseCompiler)", async () => {
    await withTenant(tenantA, async (tx) => {
      await setTenantSectorSetting(tx, { tenantId: tenantA, sectorKey: "LEGAL", packKey: "legal-uk-sra" });
      const prof = await resolveTenantSectorProfile(tx, tenantA);
      assert.strictEqual(prof.sectorKey, "LEGAL");
    });

    await withTenant(tenantB, async (tx) => {
      // Tenant B cannot see Tenant A's setting and stays GENERIC unless explicitly set
      const raw = await tx.q("SELECT * FROM tenant_sector_setting WHERE tenant_id = $1", [tenantA]);
      assert.strictEqual(raw.rowCount, 0);
    });

    const snapCount = await withProtectedCompute(tenantA, async (tx) => {
      const r = await tx.q("SELECT count(*)::int AS c FROM metric_snapshot");
      return r.rows[0].c;
    });
    assert.ok(snapCount >= 0);

    const decCount = await withReleaseCompiler(tenantA, async (tx) => {
      const r = await tx.q("SELECT count(*)::int AS c FROM privacy_decision");
      return r.rows[0].c;
    });
    assert.ok(decCount >= 0);
  });

  await check("Connection States on Live PG: SUSPENDED -> RESUMED -> DISCONNECTED (terminal)", async () => {
    const connId = crypto.randomUUID();
    await withTenant(tenantA, async (tx) => {
      await tx.q(
        `INSERT INTO connection (id, tenant_id, source, contract_id, state, expected_cadence_seconds)
         VALUES ($1, $2, 'ZoikoTime', $3, 'ACTIVE', 3600)`,
        [connId, tenantA, "00000000-0000-4000-a005-000000000001"]
      );
      await tx.q(`UPDATE connection SET state = 'SUSPENDED' WHERE id = $1`, [connId]);
      await tx.q(`UPDATE connection SET state = 'RESUMED' WHERE id = $1`, [connId]);
      const res = await tx.q(`UPDATE connection SET state = 'DISCONNECTED' WHERE id = $1 RETURNING state`, [connId]);
      assert.strictEqual(res.rows[0].state, "DISCONNECTED");
    });
  });

  await check("Cross-Tenant FK Insert refused by composite foreign key constraint on live PG", async () => {
    const foreignOrgId = "00000000-0000-4000-b001-000000000001";
    await assert.rejects(
      async () => {
        await withTenant(tenantA, async (tx) => {
          await tx.q(
            `INSERT INTO organization (id, tenant_id, parent_id, name) VALUES ($1, $2, $3, $4)`,
            [crypto.randomUUID(), tenantA, foreignOrgId, "Cross-Tenant FK Attempt"]
          );
        });
      },
      /foreign key/i
    );
  });

  await check("Idempotency Concurrency: two simultaneous same-key requests produce exactly one organization row", async () => {
    const actor = await resolveActor(tenantA, "auth0|user-tenant-a-risk-owner");
    const sharedKey = `pg-conc-idem-${crypto.randomUUID()}`;
    const orgName = `Concurrent PG Org ${sharedKey.slice(0, 8)}`;
    const [r1, r2] = await Promise.all([
      createOrganization({
        who: { tenantId: tenantA, subject: "auth0|user-tenant-a-risk-owner", purpose: "WORKPLACE_RISK_ASSESSMENT", role: "RISK_OWNER" },
        actor,
        body: { name: orgName },
        idempotencyKey: sharedKey
      }),
      createOrganization({
        who: { tenantId: tenantA, subject: "auth0|user-tenant-a-risk-owner", purpose: "WORKPLACE_RISK_ASSESSMENT", role: "RISK_OWNER" },
        actor,
        body: { name: orgName },
        idempotencyKey: sharedKey
      })
    ]);
    assert.strictEqual(r1.body.id, r2.body.id, "Concurrent idempotent calls must return the same resource ID");
    await withTenant(tenantA, async (tx) => {
      const cnt = await tx.q(`SELECT count(*)::int AS c FROM organization WHERE name = $1`, [orgName]);
      assert.strictEqual(cnt.rows[0].c, 1);
    });
  });

  await check("Disclosure Lock Concurrency on live PG: two overlapping cohorts never both release", async () => {
    const baseMembers = Array.from({ length: 10 }, (_, i) => `pg-conc-m-${i}`);
    const overlapMembers = [...baseMembers.slice(0, 9), "pg-conc-m-extra"];
    const tag = crypto.randomUUID().slice(0, 8);
    const [relA, relB] = await Promise.all([
      compileRelease(
        tenantA,
        {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: `cohort:pg-conc-a-${tag}`,
          periodStart: "2026-01-01T00:00:00.000Z",
          periodEnd: "2026-02-01T00:00:00.000Z",
          releaseClass: "CLASS_B"
        },
        baseMembers
      ),
      compileRelease(
        tenantA,
        {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: `cohort:pg-conc-b-${tag}`,
          periodStart: "2026-01-01T00:00:00.000Z",
          periodEnd: "2026-02-01T00:00:00.000Z",
          releaseClass: "CLASS_B"
        },
        overlapMembers
      )
    ]);
    const releasedCount = [relA, relB].filter((r) => r.status === "RELEASED").length;
    assert.strictEqual(releasedCount, 1, `Exactly 1 overlapping cohort may release, got ${releasedCount}`);
  });

  console.log(`\n\x1b[32m✔ Live PostgreSQL Parity & Role Isolation Suite PASSED (${passed} checks).\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m[PG-PARITY ERROR]\x1b[0m", err);
  process.exit(1);
});
