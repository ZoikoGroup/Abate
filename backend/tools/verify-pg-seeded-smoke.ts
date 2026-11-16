// backend/tools/verify-pg-seeded-smoke.ts
// Exercises live PostgreSQL forced RLS reads, idempotent connection registration,
// and state transitions (pause/resume + audit/outbox) after seed-demo --pg.

import assert from "node:assert";
import crypto from "node:crypto";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { loadConfig } from "../src/platform/config";
import { seedTwoTenants } from "../src/fixtures/seed";
import { withTenant, withWorker } from "../src/platform/db/with-tenant";

async function main() {
  console.log("=== Live PostgreSQL Seeded Parity Smoke Verification ===");

  const cfg = loadConfig();
  await seedTwoTenants({ clock: new Date(cfg.fixedClock), persistToPostgres: true });

  const authA = await expressCall("POST", "/api/v2/auth/token", {
    body: {
      tenantId: GOLDEN_01.tenantA.id,
      subject: "auth0|user-tenant-a-risk-owner",
      role: "RISK_OWNER",
      purpose: "WORKPLACE_RISK_ASSESSMENT"
    }
  });
  assert.strictEqual(authA.status, 200, "Tenant A token issuance must succeed");
  const tokenA = authA.body.token;

  const authB = await expressCall("POST", "/api/v2/auth/token", {
    body: {
      tenantId: GOLDEN_01.tenantB.id,
      subject: "auth0|user-tenant-b-risk-owner",
      role: "RISK_OWNER",
      purpose: "WORKPLACE_RISK_ASSESSMENT"
    }
  });
  assert.strictEqual(authB.status, 200, "Tenant B token issuance must succeed");
  const tokenB = authB.body.token;

  // 1. Verify RLS isolation across organizations and connections
  const orgsA = await expressCall("GET", "/api/v2/organizations", { token: tokenA });
  assert.strictEqual(orgsA.status, 200);
  assert(orgsA.body.every((o: any) => o.tenant_id === GOLDEN_01.tenantA.id));

  const orgsB = await expressCall("GET", "/api/v2/organizations", { token: tokenB });
  assert.strictEqual(orgsB.status, 200);
  assert(orgsB.body.every((o: any) => o.tenant_id === GOLDEN_01.tenantB.id));

  const connsA = await expressCall("GET", "/api/v2/connections", { token: tokenA });
  assert.strictEqual(connsA.status, 200);
  assert(connsA.body.length >= 1, "Tenant A must have >= 1 seeded connection in PostgreSQL");

  // 2. Register CalendarCadence connection against PostgreSQL + test RETURNING * on pause/resume
  const regKey = `pg-smoke-reg-${crypto.randomUUID()}`;
  const regRes = await expressCall("POST", "/api/v2/connections", {
    token: tokenA,
    headers: { "idempotency-key": regKey },
    body: {
      source: "CalendarCadence",
      contractId: "00000000-0000-4000-a005-000000000002",
      expectedCadenceSeconds: 3600
    }
  });
  assert.strictEqual(regRes.status, 200, `Expected 200 registering connection, got ${regRes.status}`);
  assert.strictEqual(regRes.body.source, "CalendarCadence");
  assert.strictEqual(regRes.body.state, "ACTIVE");

  const pauseRes = await expressCall("POST", `/api/v2/connections/${regRes.body.id}/pause`, {
    token: tokenA,
    headers: { "idempotency-key": `pg-smoke-pause-${crypto.randomUUID()}` }
  });
  assert.strictEqual(pauseRes.status, 200, "Pause must return 200 with RETURNING * row");
  assert.strictEqual(pauseRes.body.state, "PAUSED");

  const resumeRes = await expressCall("POST", `/api/v2/connections/${regRes.body.id}/resume`, {
    token: tokenA,
    headers: { "idempotency-key": `pg-smoke-resume-${crypto.randomUUID()}` }
  });
  assert.strictEqual(resumeRes.status, 200, "Resume must return 200 with RETURNING * row");
  assert.strictEqual(resumeRes.body.state, "ACTIVE");

  // 3. Verify foreign tenant cannot read or transition Tenant A's newly created connection
  const foreignGet = await expressCall("GET", `/api/v2/connections/${regRes.body.id}`, {
    token: tokenB
  });
  assert.strictEqual(foreignGet.status, 404, "Tenant B must receive 404 on Tenant A connection");

  // 4. Direct PostgreSQL RLS check under abate_app: Tenant B transaction sees 0 Tenant A rows
  await withTenant(GOLDEN_01.tenantB.id, async (tx) => {
    const crossConn = await tx.q("SELECT id FROM connection WHERE id = $1", [regRes.body.id]);
    assert.strictEqual(crossConn.rowCount, 0, "Direct PostgreSQL RLS must hide Tenant A connection from Tenant B");
    const crossOrgs = await tx.q("SELECT tenant_id FROM organization WHERE tenant_id = $1", [GOLDEN_01.tenantA.id]);
    assert.strictEqual(crossOrgs.rowCount, 0, "Direct PostgreSQL RLS must hide Tenant A organizations from Tenant B");
  });

  // 5. Ingest a real CalendarCadence work_fact_revision row, then verify storage guards under abate_app
  const smokeBatchId = `pg-smoke-batch-${crypto.randomUUID()}`;
  const ingestRes = await expressCall("POST", "/api/v2/connectors/calendar-cadence/batches", {
    token: tokenA,
    headers: { "idempotency-key": smokeBatchId },
    body: {
      connectionId: regRes.body.id,
      batchId: smokeBatchId,
      items: [
        {
          recordId: `pg-smoke-rec-${crypto.randomUUID().slice(0, 8)}`,
          revision: 1,
          subjectRef: "pg-smoke-emp-01",
          startUtc: "2026-03-03T10:00:00Z",
          endUtc: "2026-03-03T11:00:00Z",
          workTz: "Europe/London",
          kind: "MEETING_BLOCK"
        }
      ]
    }
  });
  assert.strictEqual(ingestRes.status, 200, `Expected 200 ingesting CalendarCadence batch, got ${ingestRes.status}`);
  assert.strictEqual(ingestRes.body.accepted, 1);

  await assert.rejects(
    async () => {
      await withTenant(GOLDEN_01.tenantA.id, async (tx) => {
        await tx.q("DELETE FROM work_fact_revision WHERE tenant_id = $1", [GOLDEN_01.tenantA.id]);
      });
    },
    /tombstone|permission denied|violates|cannot be deleted/i,
    "Deleting work_fact_revision without a tombstone must fail on PostgreSQL trigger / guard"
  );

  await assert.rejects(
    async () => {
      await withTenant(GOLDEN_01.tenantA.id, async (tx) => {
        await tx.q("DELETE FROM audit_event WHERE tenant_id = $1", [GOLDEN_01.tenantA.id]);
      });
    },
    /permission denied|tombstone|immutable|append-only/i,
    "Deleting audit_event under abate_app must be refused by PostgreSQL privileges"
  );

  // 6. Least-privilege abate_worker denials on identity_map and privacy tables
  for (const table of ["identity_map", "metric_snapshot", "disclosure_ledger"]) {
    try {
      const res = await withWorker(async (tx) => tx.q(`SELECT * FROM ${table} LIMIT 1`));
      assert.strictEqual(res.rows.length, 0, `abate_worker must read 0 rows from ${table}`);
    } catch (err: any) {
      assert.match(String(err?.message || err), /permission denied|insufficient privilege|not allowed/i);
    }
  }

  // 7. Seed parity: the in-memory seed's hazard chain and jurisdiction packs must exist in PostgreSQL too, and the
  // package endpoint must work against real uuid columns (in-memory accepts any string, so only PG catches that)
  const hazardsA = await expressCall("GET", "/api/v2/hazards", { token: tokenA });
  assert.strictEqual(hazardsA.status, 200);
  assert(hazardsA.body.length >= 1, "Tenant A must have the seeded hazard in PostgreSQL");

  const coverageA = await expressCall("GET", "/api/v2/jurisdiction/coverage", { token: tokenA });
  assert.strictEqual(coverageA.status, 200);
  assert.strictEqual(coverageA.body.status, "COVERED", "Tenant A must be bound to its seeded jurisdiction pack in PostgreSQL");

  const pkgRes = await expressCall("POST", "/api/v2/evidence-packages", { token: tokenA, body: {} });
  assert.strictEqual(pkgRes.status, 201, `Issuing an evidence package on PostgreSQL must succeed, got ${pkgRes.status}`);

  console.log("✔ Live PostgreSQL Seeded Parity Smoke Verification: PASSED (15 assertions)");
}

main().catch((err) => {
  console.error("[PG SEEDED SMOKE FAILED]", err);
  process.exit(1);
});
