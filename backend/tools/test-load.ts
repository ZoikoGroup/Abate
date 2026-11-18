// backend/tools/test-load.ts
// Load, Capacity & Concurrency Test Runner (Playbook B8 §8.2 / Stage B Item 2 Measurement)
// Supports:
//   - Direct domain mode (default) or HTTP mode (--http) or real TCP loopback (--http --tcp)
//   - Manifest-scale workload (--manifest-scale): 20 tenants, 1,500 principals on largest tenant,
//     400,000 baseline facts in live Postgres, 150 concurrent releases, p50 ~4 KB / p95 ~64 KB batches,
//     and concurrent background outbox worker draining.
// Writes evidence/slo-benchmark-report.json with honest evidenceClassification.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { Actor } from "../src/platform/command";
import { loadConfig } from "../src/platform/config";
import { checkPgHealth, memDb, withTenant } from "../src/platform/db/with-tenant";
import { p95 } from "../src/platform/slo";
import { compileRelease } from "../src/domains/privacy";
import { createOrganization } from "../src/domains/tenant/commands";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { app } from "../src/index";
import { drainBatch, getWorkerMetrics, resetWorkerMetrics } from "../src/worker/daemon";
import { expressCall } from "./simulate-30d-http";

const HTTP_MODE = process.argv.includes("--http");
const TCP_MODE = process.argv.includes("--tcp");
const MANIFEST_SCALE = process.argv.includes("--manifest-scale");

const TOTAL_RELEASE_REQUESTS = 150; // Aligned with ops/slo-manifest.v1.yaml peak_concurrency: 150
const DEFAULT_CONCURRENCY_BATCH = 15;
const MANIFEST_TENANT_COUNT = 20;
const MANIFEST_LARGEST_PRINCIPALS = 1500;
const MANIFEST_BASELINE_FACTS = 400_000;

const tenantA = GOLDEN_01.tenantA.id;
const tenantB = GOLDEN_01.tenantB.id;
const CAL_CONTRACT_A = "00000000-0000-4000-a005-000000000002";
const CAL_CONTRACT_B = "00000000-0000-4000-b005-000000000002";
const CAL_CONN_A = "00000000-0000-4000-a004-000000000002";
const CAL_CONN_B = "00000000-0000-4000-b004-000000000002";

interface LoadTenantContext {
  tenantId: string;
  orgId: string;
  subject: string;
  calConnectionId: string;
  token?: string;
}

const actorA: Actor = {
  tenantId: tenantA,
  principalId: "00000000-0000-4000-a002-000000000001",
  memberships: [{ domain_role: "RISK_OWNER", organization_id: "00000000-0000-4000-a001-000000000001" }]
};

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function runInBatches(tasks: Array<() => Promise<void>>, batchSize: number): Promise<void> {
  for (let i = 0; i < tasks.length; i += batchSize) {
    await Promise.all(tasks.slice(i, i + batchSize).map((fn) => fn()));
  }
}

async function withTenantSeedTx<T>(
  pool: Pool,
  tenantId: string,
  fn: (q: (sql: string, params?: any[]) => Promise<any>) => Promise<T>
): Promise<T> {
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

async function ensureCalendarConnectionPg(
  pool: Pool,
  tenantId: string,
  contractId: string,
  defaultConnId: string
): Promise<string> {
  return withTenantSeedTx(pool, tenantId, async (q) => {
    const existing = await q(
      `SELECT id FROM connection WHERE tenant_id = $1 AND source = 'CalendarCadence' AND state = 'ACTIVE' LIMIT 1`,
      [tenantId]
    );
    if (existing.rowCount > 0) {
      return existing.rows[0].id as string;
    }
    await q(
      `INSERT INTO connection (id, tenant_id, source, contract_id, state, last_success_at, expected_cadence_seconds)
       VALUES ($1, $2, 'CalendarCadence', $3, 'ACTIVE', now(), 3600)
       ON CONFLICT (id) DO NOTHING`,
      [defaultConnId, tenantId, contractId]
    );
    return defaultConnId;
  });
}

function ensureCalendarConnectionMemory(tenantId: string, contractId: string, defaultConnId: string): string {
  for (const conn of memDb.connections.values()) {
    if (conn.tenant_id === tenantId && conn.source === "CalendarCadence" && conn.state === "ACTIVE") {
      return conn.id;
    }
  }
  memDb.connections.set(defaultConnId, {
    id: defaultConnId,
    tenant_id: tenantId,
    source: "CalendarCadence",
    contract_id: contractId,
    state: "ACTIVE",
    last_success_at: new Date().toISOString(),
    expected_cadence_seconds: 3600
  });
  return defaultConnId;
}

async function prepareWorkload(pgLive: boolean): Promise<{
  tenants: LoadTenantContext[];
  largestTenantPrincipals: number;
  baselineFactsSeeded: number;
}> {
  if (MANIFEST_SCALE && !pgLive) {
    throw new Error("--manifest-scale requires live PostgreSQL (check DATABASE_URL_* and run migrations first).");
  }

  await seedTwoTenants({ clock: new Date(loadConfig().fixedClock), persistToPostgres: pgLive });

  if (!pgLive) {
    const connA = ensureCalendarConnectionMemory(tenantA, CAL_CONTRACT_A, CAL_CONN_A);
    const connB = ensureCalendarConnectionMemory(tenantB, CAL_CONTRACT_B, CAL_CONN_B);
    return {
      tenants: [
        {
          tenantId: tenantA,
          orgId: "00000000-0000-4000-a001-000000000001",
          subject: "auth0|user-tenant-a-risk-owner",
          calConnectionId: connA
        },
        {
          tenantId: tenantB,
          orgId: "00000000-0000-4000-b001-000000000001",
          subject: "auth0|user-tenant-b-risk-owner",
          calConnectionId: connB
        }
      ],
      largestTenantPrincipals: 16,
      baselineFactsSeeded: 0
    };
  }

  const cfg = loadConfig();
  const seedPool = new Pool({ connectionString: cfg.databaseUrlMigrator, max: 4 });
  try {
    const connA = await ensureCalendarConnectionPg(seedPool, tenantA, CAL_CONTRACT_A, CAL_CONN_A);
    const connB = await ensureCalendarConnectionPg(seedPool, tenantB, CAL_CONTRACT_B, CAL_CONN_B);

    const contexts: LoadTenantContext[] = [
      {
        tenantId: tenantA,
        orgId: "00000000-0000-4000-a001-000000000001",
        subject: "auth0|user-tenant-a-risk-owner",
        calConnectionId: connA
      },
      {
        tenantId: tenantB,
        orgId: "00000000-0000-4000-b001-000000000001",
        subject: "auth0|user-tenant-b-risk-owner",
        calConnectionId: connB
      }
    ];

    if (!MANIFEST_SCALE) {
      return { tenants: contexts, largestTenantPrincipals: 16, baselineFactsSeeded: 0 };
    }

    console.log(`  Seeding manifest-scale fixtures (${MANIFEST_TENANT_COUNT} tenants, ${MANIFEST_LARGEST_PRINCIPALS} principals, ${MANIFEST_BASELINE_FACTS.toLocaleString()} baseline facts)...`);

    // 1. Expand Tenant A to 1,500 principals and memberships
    const largestPrincipals = await withTenantSeedTx(seedPool, tenantA, async (q) => {
      const cntRes = await q(`SELECT COUNT(*)::int AS cnt FROM principal WHERE tenant_id = $1`, [tenantA]);
      const current = Number(cntRes.rows[0]?.cnt ?? 0);
      const needed = Math.max(0, MANIFEST_LARGEST_PRINCIPALS - current);
      if (needed > 0) {
        await q(
          `INSERT INTO principal (id, tenant_id, external_subject, kind)
           SELECT
             ('00000000-0000-4000-a102-' || lpad(to_hex(g), 12, '0'))::uuid,
             $1,
             'auth0|manifest-member-' || lpad(g::text, 4, '0'),
             'USER'
           FROM generate_series(1, $2::int) AS g
           ON CONFLICT DO NOTHING`,
          [tenantA, needed]
        );
        await q(
          `INSERT INTO effective_membership (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, recorded_at)
           SELECT
             ('00000000-0000-4000-a103-' || lpad(to_hex(g), 12, '0'))::uuid,
             $1,
             p.id,
             $2,
             'MEMBER',
             '2025-12-01T00:00:00Z'::timestamptz,
             NULL,
             now()
           FROM generate_series(1, $3::int) AS g
           JOIN principal p ON p.tenant_id = $1 AND p.external_subject = ('auth0|manifest-member-' || lpad(g::text, 4, '0'))
           ON CONFLICT DO NOTHING`,
          [tenantA, contexts[0]!.orgId, needed]
        );
      }
      const afterRes = await q(`SELECT COUNT(*)::int AS cnt FROM principal WHERE tenant_id = $1`, [tenantA]);
      return Number(afterRes.rows[0]?.cnt ?? MANIFEST_LARGEST_PRINCIPALS);
    });

    // 2. Seed remaining 18 tenants (total = 20 tenants) with org, 16 principals, and active CalendarCadence connection
    for (let idx = 3; idx <= MANIFEST_TENANT_COUNT; idx++) {
      const suffix = String(idx).padStart(12, "0");
      const tId = `00000000-0000-4000-d000-${suffix}`;
      const orgId = `00000000-0000-4000-d001-${suffix}`;
      const ownerId = `00000000-0000-4000-d002-${suffix}`;
      const ownerMemId = `00000000-0000-4000-d003-${suffix}`;
      const calConnId = `00000000-0000-4000-d004-${suffix}`;
      const calContractId = `00000000-0000-4000-d005-${suffix}`;
      const ownerSubject = `auth0|manifest-owner-${idx}`;

      await withTenantSeedTx(seedPool, tId, async (q) => {
        await q(
          `INSERT INTO tenant (id, name, region, jurisdiction_config_ref, created_at)
           VALUES ($1, $2, 'eu-west-2', 'legal-uk-sra', '2025-12-01T00:00:00Z'::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [tId, `Manifest Load Tenant ${idx}`]
        );
        await q(
          `INSERT INTO organization (id, tenant_id, parent_id, name)
           VALUES ($1, $2, NULL, $3)
           ON CONFLICT (id) DO NOTHING`,
          [orgId, tId, `Practice Division ${idx}`]
        );
        await q(
          `INSERT INTO principal (id, tenant_id, external_subject, kind)
           VALUES ($1, $2, $3, 'USER')
           ON CONFLICT (id) DO NOTHING`,
          [ownerId, tId, ownerSubject]
        );
        await q(
          `INSERT INTO effective_membership (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, recorded_at)
           VALUES ($1, $2, $3, $4, 'RISK_OWNER', '2025-12-01T00:00:00Z'::timestamptz, NULL, now())
           ON CONFLICT (id) DO NOTHING`,
          [ownerMemId, tId, ownerId, orgId]
        );
        await q(
          `INSERT INTO principal (id, tenant_id, external_subject, kind)
           SELECT
             ('00000000-0000-4000-d' || lpad(to_hex($2::int), 3, '0') || '-' || lpad(to_hex(g), 12, '0'))::uuid,
             $1,
             'auth0|manifest-tenant-' || $2::text || '-member-' || lpad(g::text, 3, '0'),
             'USER'
           FROM generate_series(1, 15) AS g
           ON CONFLICT DO NOTHING`,
          [tId, idx]
        );
        await q(
          `INSERT INTO effective_membership (id, tenant_id, principal_id, organization_id, domain_role, valid_from, valid_to, recorded_at)
           SELECT
             ('00000000-0000-4000-e' || lpad(to_hex($3::int), 3, '0') || '-' || lpad(to_hex(g), 12, '0'))::uuid,
             $1,
             ('00000000-0000-4000-d' || lpad(to_hex($3::int), 3, '0') || '-' || lpad(to_hex(g), 12, '0'))::uuid,
             $2,
             'MEMBER',
             '2025-12-01T00:00:00Z'::timestamptz,
             NULL,
             now()
           FROM generate_series(1, 15) AS g
           ON CONFLICT DO NOTHING`,
          [tId, orgId, idx]
        );
        await q(
          `INSERT INTO source_contract (id, tenant_id, source, version, contract_hash, status)
           VALUES ($1, $2, 'CalendarCadence', 'v1.0', 'sha256-contract-calendar-cadence-v1.0-approved', 'ACTIVE')
           ON CONFLICT DO NOTHING`,
          [calContractId, tId]
        );
        await q(
          `INSERT INTO connection (id, tenant_id, source, contract_id, state, last_success_at, expected_cadence_seconds)
           VALUES ($1, $2, 'CalendarCadence', $3, 'ACTIVE', now(), 3600)
           ON CONFLICT (id) DO NOTHING`,
          [calConnId, tId, calContractId]
        );
      });

      contexts.push({
        tenantId: tId,
        orgId,
        subject: ownerSubject,
        calConnectionId: calConnId
      });
    }

    // 3. Seed 400,000 baseline work_fact_revision rows on Tenant A (idempotent, chunked)
    const seededFacts = await withTenantSeedTx(seedPool, tenantA, async (q) => {
      const existingRes = await q(
        `SELECT COUNT(*)::int AS cnt FROM work_fact_revision WHERE tenant_id = $1 AND source_record_id LIKE 'manifest-seed-%'`,
        [tenantA]
      );
      let current = Number(existingRes.rows[0]?.cnt ?? 0);
      if (current >= MANIFEST_BASELINE_FACTS) {
        return current;
      }

      const seedReceiptId = "00000000-0000-4000-e100-000000000001";
      await q(
        `INSERT INTO ingest_receipt (id, tenant_id, connection_id, batch_id, accepted, duplicate, rejected, conflicted)
         VALUES ($1, $2, $3, 'manifest-baseline-400k', $4, 0, 0, 0)
         ON CONFLICT (tenant_id, connection_id, batch_id) DO NOTHING`,
        [seedReceiptId, tenantA, "00000000-0000-4000-a004-000000000001", MANIFEST_BASELINE_FACTS]
      );
      const rcRes = await q(
        `SELECT id FROM ingest_receipt WHERE tenant_id = $1 AND connection_id = $2 AND batch_id = 'manifest-baseline-400k'`,
        [tenantA, "00000000-0000-4000-a004-000000000001"]
      );
      const receiptId = rcRes.rows[0].id as string;

      const chunkSize = 100_000;
      for (let start = current + 1; start <= MANIFEST_BASELINE_FACTS; start += chunkSize) {
        const end = Math.min(MANIFEST_BASELINE_FACTS, start + chunkSize - 1);
        await q(
          `INSERT INTO work_fact_revision (
             id, tenant_id, connection_id, source_record_id, revision,
             subject_pseudonym, start_at, end_at, work_tz, kind, payload_hash, receipt_id
           )
           SELECT
             ('00000000-0000-4000-e000-' || lpad(to_hex(g), 12, '0'))::uuid,
             $1,
             $2,
             'manifest-seed-' || g::text,
             1,
             'manifest-pseudo-' || lpad((g % $6::int)::text, 4, '0'),
             '2026-03-02T09:00:00Z'::timestamptz + ((g % 20) * interval '1 day') + ((g % 8) * interval '1 hour'),
             '2026-03-02T10:00:00Z'::timestamptz + ((g % 20) * interval '1 day') + ((g % 8) * interval '1 hour'),
             'Europe/London',
             'WORK',
             'sha256-manifest-seed',
             $3
           FROM generate_series($4::int, $5::int) AS g
           ON CONFLICT (tenant_id, connection_id, source_record_id, revision) DO NOTHING`,
          [tenantA, "00000000-0000-4000-a004-000000000001", receiptId, start, end, MANIFEST_LARGEST_PRINCIPALS]
        );
      }

      const afterRes = await q(
        `SELECT COUNT(*)::int AS cnt FROM work_fact_revision WHERE tenant_id = $1 AND source_record_id LIKE 'manifest-seed-%'`,
        [tenantA]
      );
      current = Number(afterRes.rows[0]?.cnt ?? MANIFEST_BASELINE_FACTS);
      return current;
    });

    return {
      tenants: contexts,
      largestTenantPrincipals: largestPrincipals,
      baselineFactsSeeded: seededFacts
    };
  } finally {
    await seedPool.end();
  }
}

function buildCalendarBatchPayload(connectionId: string, itemCount: number, batchTag: string) {
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    items.push({
      recordId: `${batchTag}-item-${i}`,
      revision: 1,
      subjectRef: `load-subj-${i % 250}`,
      startUtc: "2026-03-03T10:00:00Z",
      endUtc: "2026-03-03T11:00:00Z",
      workTz: "Europe/London",
      kind: i % 5 === 0 ? "AFTER_HOURS_CALL" : "MEETING_BLOCK"
    });
  }
  return {
    connectionId,
    batchId: batchTag,
    items
  };
}

function startBackgroundWorkerLoop(): {
  stopAndDrain: () => Promise<{ drainDurationMs: number; maxQueueLagMs: number }>;
} {
  resetWorkerMetrics();
  let active = true;
  let maxQueueLagMs = 0;

  const loopPromise = (async () => {
    while (active) {
      const res = await drainBatch({ batchSize: 100 });
      if (res.queueLagMs > maxQueueLagMs) maxQueueLagMs = res.queueLagMs;
      if (!active) break;
      if (res.processed === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  })();

  return {
    stopAndDrain: async () => {
      active = false;
      await loopPromise;
      const drainStart = Date.now();
      for (let i = 0; i < 60; i++) {
        const res = await drainBatch({ batchSize: 200 });
        if (res.queueLagMs > maxQueueLagMs) maxQueueLagMs = res.queueLagMs;
        if (res.processed === 0) break;
      }
      return {
        drainDurationMs: Date.now() - drainStart,
        maxQueueLagMs
      };
    }
  };
}

async function runLoadTests() {
  const modeLabel = `${HTTP_MODE ? "REAL HTTP" : "DIRECT DOMAIN"}${MANIFEST_SCALE ? " + MANIFEST SCALE" : ""}`;
  console.log(`\x1b[36m=== Abate Task Runner: test-load (${modeLabel}) ===\x1b[0m`);

  const pgLive = await checkPgHealth();
  const dataset = await prepareWorkload(pgLive);

  const readLatencies: number[] = [];
  const writeLatencies: number[] = [];
  const releaseLatencies: number[] = [];
  const tenantBLatencies: number[] = [];
  const payloadByteSizes: number[] = [];
  let countLeaksDetected = 0;
  let errorCount = 0;

  const releaseBatchConcurrency = MANIFEST_SCALE ? TOTAL_RELEASE_REQUESTS : DEFAULT_CONCURRENCY_BATCH;
  const mixedBatchConcurrency = MANIFEST_SCALE ? 30 : DEFAULT_CONCURRENCY_BATCH;
  const ingestBatchCount = MANIFEST_SCALE ? 40 : 10;
  const ingestionConcurrency = MANIFEST_SCALE ? 10 : 5;
  const mixedPairs = MANIFEST_SCALE ? 100 : 50;

  const workerLoop = startBackgroundWorkerLoop();

  if (HTTP_MODE) {
    let server: ReturnType<typeof app.listen> | null = null;
    let base = "";
    if (TCP_MODE) {
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    const callHttp = async (
      method: "GET" | "POST",
      urlPath: string,
      opts: { token?: string; body?: any; idempotencyKey?: string } = {}
    ): Promise<{ status: number; body: any; raw: string }> => {
      if (TCP_MODE) {
        const headers: Record<string, string> = {};
        if (opts.body !== undefined) headers["content-type"] = "application/json";
        if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
        if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
        const res = await fetch(`${base}${urlPath}`, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
        });
        const raw = await res.text();
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* non-JSON */
        }
        return { status: res.status, body, raw };
      }
      const headers: Record<string, string> = {};
      if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
      return expressCall(method, urlPath, { token: opts.token, body: opts.body, headers });
    };

    try {
      for (const t of dataset.tenants) {
        const tokRes = await callHttp("POST", "/api/v2/auth/token", {
          body: {
            tenantId: t.tenantId,
            subject: t.subject,
            role: "RISK_OWNER"
          }
        });
        assert.strictEqual(tokRes.status, 200, `Failed to issue load token for tenant ${t.tenantId}`);
        t.token = tokRes.body.token as string;
      }

      const tokA = dataset.tenants[0]!.token!;
      const tokB = dataset.tenants[1]!.token!;

      console.log(
        `  Running HTTP Release Compile Burst (${TOTAL_RELEASE_REQUESTS} requests, batch=${releaseBatchConcurrency}, ${TCP_MODE ? "TCP" : "Express"})...`
      );
      const releaseTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < TOTAL_RELEASE_REQUESTS; i++) {
        const targetTenant = MANIFEST_SCALE ? dataset.tenants[i % dataset.tenants.length]! : dataset.tenants[0]!;
        releaseTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("POST", "/api/v2/releases/query", {
            token: targetTenant.token,
            idempotencyKey: `load-rel-${crypto.randomUUID()}`,
            body: {
              metricId: "BOUNDARY_INTRUSION_SHARE",
              metricVersion: 1,
              cohortRef: `org:${targetTenant.orgId}`,
              periodStart: "2026-03-01T00:00:00Z",
              periodEnd: "2026-03-29T00:00:00Z",
              releaseClass: "CLASS_B"
            }
          });
          releaseLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
          if (/\bcontributor_count\b|\bcontributors\b/i.test(res.raw)) {
            countLeaksDetected++;
          }
        });
      }
      await runInBatches(releaseTasks, releaseBatchConcurrency);

      console.log(`  Running HTTP Ingestion Batches (${ingestBatchCount} batches: p50 ~4 KB, p95 ~64 KB)...`);
      const largeCount = Math.max(1, Math.round(ingestBatchCount * 0.08));
      const ingestTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < ingestBatchCount; i++) {
        const isLarge = i >= ingestBatchCount - largeCount;
        const itemCount = isLarge ? 345 : 21;
        const targetTenant = dataset.tenants[i % dataset.tenants.length]!;
        const tag = `load-ing-${crypto.randomUUID().slice(0, 8)}-${i}`;
        const batchBody = buildCalendarBatchPayload(targetTenant.calConnectionId, itemCount, tag);
        payloadByteSizes.push(Buffer.byteLength(JSON.stringify(batchBody), "utf8"));

        ingestTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("POST", "/api/v2/connectors/calendar-cadence/batches", {
            token: targetTenant.token,
            idempotencyKey: tag,
            body: batchBody
          });
          writeLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
        });
      }
      await runInBatches(ingestTasks, ingestionConcurrency);

      console.log(`  Running HTTP mixed Read & Mutation load (${mixedPairs * 2} requests across Organizations)...`);
      const mixedTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < mixedPairs; i++) {
        const targetTenant = MANIFEST_SCALE ? dataset.tenants[i % dataset.tenants.length]! : dataset.tenants[0]!;
        mixedTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("POST", "/api/v2/organizations", {
            token: targetTenant.token,
            idempotencyKey: `load-http-org-${crypto.randomUUID()}`,
            body: { name: `HTTP Load Org ${i}-${crypto.randomUUID().slice(0, 6)}` }
          });
          writeLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
        });
        mixedTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("GET", "/api/v2/organizations", { token: targetTenant.token });
          readLatencies.push(Date.now() - start);
          if (res.status >= 500) errorCount++;
        });
      }
      await runInBatches(mixedTasks, mixedBatchConcurrency);

      console.log("  Testing HTTP Noisy-Tenant Isolation (Tenant A burst vs Tenant B read)...");
      const noisyTasks: Array<() => Promise<void>> = [];
      for (let i = 0; i < 50; i++) {
        noisyTasks.push(async () => {
          await callHttp("GET", "/api/v2/organizations", { token: tokA });
        });
      }
      for (let i = 0; i < 10; i++) {
        noisyTasks.push(async () => {
          const start = Date.now();
          const res = await callHttp("GET", "/api/v2/organizations", { token: tokB });
          tenantBLatencies.push(Date.now() - start);
          const rows = res.body as Array<{ tenant_id: string }>;
          assert(rows.every((r) => r.tenant_id === tenantB), "Cross-tenant leak detected during HTTP load!");
        });
      }
      await Promise.all(noisyTasks.map((fn) => fn()));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    }
  } else {
    console.log("  Running Release Compile Burst scenario (150 concurrent requests)...");
    const releaseTasks: Array<() => Promise<void>> = [];
    for (let i = 0; i < TOTAL_RELEASE_REQUESTS; i++) {
      releaseTasks.push(async () => {
        const start = Date.now();
        const res = await compileRelease(tenantA, {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: "tenantA-ops",
          periodStart: "2026-01-05T00:00:00Z",
          periodEnd: "2026-03-01T00:00:00Z",
          releaseClass: "CLASS_B"
        });
        releaseLatencies.push(Date.now() - start);
        if (/\bcontributor_count\b|\bcontributors\b/i.test(JSON.stringify(res))) {
          countLeaksDetected++;
        }
      });
    }
    await runInBatches(releaseTasks, DEFAULT_CONCURRENCY_BATCH);

    console.log("  Running mixed Read & Mutation load (Organizations & Releases)...");
    const mixedTasks: Array<() => Promise<void>> = [];
    for (let i = 0; i < 50; i++) {
      mixedTasks.push(async () => {
        const start = Date.now();
        await createOrganization({
          who: { tenantId: tenantA, subject: "auth0|user-tenant-a-risk-owner", purpose: "load-test", role: "RISK_OWNER" },
          actor: actorA,
          body: { name: `Load Org ${i}-${crypto.randomUUID().slice(0, 6)}` },
          idempotencyKey: `load-${crypto.randomUUID()}`
        });
        writeLatencies.push(Date.now() - start);
      });
      mixedTasks.push(async () => {
        const start = Date.now();
        await withTenant(tenantA, async (tx) => tx.q("SELECT id, name, version FROM organization LIMIT 10"));
        readLatencies.push(Date.now() - start);
      });
    }
    await runInBatches(mixedTasks, DEFAULT_CONCURRENCY_BATCH);

    console.log("  Testing Noisy-Tenant Isolation (Tenant A 10x burst vs Tenant B baseline)...");
    const noisyTasks: Array<() => Promise<void>> = [];
    for (let i = 0; i < 50; i++) {
      noisyTasks.push(async () => {
        await withTenant(tenantA, async (tx) => tx.q("SELECT * FROM organization"));
      });
    }
    for (let i = 0; i < 10; i++) {
      noisyTasks.push(async () => {
        const start = Date.now();
        const res = await withTenant(tenantB, async (tx) => tx.q("SELECT * FROM organization"));
        tenantBLatencies.push(Date.now() - start);
        assert(res.rows.every((r) => r.tenant_id === tenantB), "Cross-tenant leak detected during load!");
      });
    }
    await Promise.all(noisyTasks.map((fn) => fn()));
  }

  const workerFinish = await workerLoop.stopAndDrain();
  const workerMetrics = getWorkerMetrics();

  const releaseP95 = p95(releaseLatencies) ?? 0;
  const writeP95 = p95(writeLatencies) ?? 0;
  const readP95 = p95(readLatencies) ?? 0;
  const tenantBP95 = p95(tenantBLatencies) ?? 0;
  const payloadP50Bytes = percentile(payloadByteSizes, 50);
  const payloadP95Bytes = percentile(payloadByteSizes, 95);

  const executionBacking = pgLive
    ? HTTP_MODE
      ? "POSTGRESQL_LIVE_HTTP"
      : "POSTGRESQL_LIVE_DIRECT"
    : HTTP_MODE
      ? "MEMORY_SANDBOX_HTTP"
      : "MEMORY_SANDBOX_DIRECT";

  console.log(`\n  --- Measured Concurrency & Latency Results (${executionBacking}) ---`);
  console.log(`  Release Analytics p95: ${releaseP95} ms (Manifest target: <= 1500 ms)`);
  console.log(`  Mutations p95:         ${writeP95} ms (Manifest target: <= 800 ms)`);
  console.log(`  Ordinary Reads p95:    ${readP95} ms (Manifest target: <= 500 ms)`);
  console.log(`  Noisy Tenant B p95:    ${tenantBP95} ms (Isolated from Tenant A burst)`);
  console.log(`  Worker Processed:      ${workerMetrics.totalProcessed} (Failures: ${workerMetrics.totalFailures}, DLQ: ${workerMetrics.totalDeadLetters}, MaxLag: ${workerFinish.maxQueueLagMs} ms)`);
  console.log(`  Contributor Leaks:     ${countLeaksDetected} (Constitutional requirement: 0)`);
  console.log(`  5xx Responses:         ${errorCount}`);

  assert.strictEqual(countLeaksDetected, 0, "Constitutional Violation: Contributor counts leaked under load!");
  assert.strictEqual(errorCount, 0, `Unexpected 5xx errors under load: ${errorCount}`);
  assert.strictEqual(workerMetrics.totalFailures, 0, `Worker experienced failures during load: ${workerMetrics.totalFailures}`);
  assert.strictEqual(workerMetrics.totalDeadLetters, 0, `Worker moved events to DLQ during load: ${workerMetrics.totalDeadLetters}`);
  assert(releaseP95 <= 1500, `Release p95 ${releaseP95}ms breached 1500ms target`);
  assert(writeP95 <= 800, `Write p95 ${writeP95}ms breached 800ms target`);
  assert(readP95 <= 500, `Read p95 ${readP95}ms breached 500ms target`);

  const evidenceClassification =
    process.env.CI === "true" || !pgLive
      ? "CI_INDICATIVE"
      : process.env.ABATE_MEASURED_ENV
        ? "FIXED_ENV_MEASURED"
        : "UNCLASSIFIED_LOCAL_PG";

  const report = {
    schema: "abate.slo-benchmark.v1",
    generatedAt: new Date().toISOString(),
    manifestAligned: MANIFEST_SCALE,
    evidenceClassification,
    evidenceNotice:
      evidenceClassification === "FIXED_ENV_MEASURED"
        ? `Fixed-environment measured run (${process.env.ABATE_MEASURED_ENV}).`
        : "CI / sandbox indicative numbers only — not fixed-environment measured evidence.",
    machine: {
      environmentLabel: process.env.ABATE_MEASURED_ENV || (process.env.CI === "true" ? "github-actions-runner" : "local-workstation"),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / (1024 * 1024))
    },
    workload: {
      seededTenants: dataset.tenants.length,
      largestTenantPrincipals: dataset.largestTenantPrincipals,
      baselineFactsSeeded: dataset.baselineFactsSeeded,
      concurrentReleaseRequests: TOTAL_RELEASE_REQUESTS,
      peakConcurrency: releaseBatchConcurrency,
      ingestionBatches: HTTP_MODE ? ingestBatchCount : 0,
      mixedReadWriteRequests: mixedPairs * 2,
      noisyTenantBurstReads: 60,
      payloadSizeBytes: HTTP_MODE
        ? {
            count: payloadByteSizes.length,
            p50Bytes: payloadP50Bytes,
            p95Bytes: payloadP95Bytes,
            p50Kb: Math.round((payloadP50Bytes / 1024) * 10) / 10,
            p95Kb: Math.round((payloadP95Bytes / 1024) * 10) / 10
          }
        : null
    },
    worker: {
      exercised: true,
      processed: workerMetrics.totalProcessed,
      failures: workerMetrics.totalFailures,
      deadLetters: workerMetrics.totalDeadLetters,
      maxQueueLagMs: workerFinish.maxQueueLagMs,
      drainDurationMs: workerFinish.drainDurationMs
    },
    executionBacking,
    postgresBacked: pgLive,
    httpExercised: HTTP_MODE,
    targets: { readsP95Ms: 500, writesP95Ms: 800, releasesP95Ms: 1500 },
    measured: {
      reads: { count: readLatencies.length, p50Ms: percentile(readLatencies, 50), p95Ms: readP95, p99Ms: percentile(readLatencies, 99) },
      writes: { count: writeLatencies.length, p50Ms: percentile(writeLatencies, 50), p95Ms: writeP95, p99Ms: percentile(writeLatencies, 99) },
      releases: { count: releaseLatencies.length, p50Ms: percentile(releaseLatencies, 50), p95Ms: releaseP95, p99Ms: percentile(releaseLatencies, 99) },
      noisyTenantBReads: { count: tenantBLatencies.length, p95Ms: tenantBP95 },
      contributorLeaks: countLeaksDetected,
      serverErrors5xx: errorCount
    },
    passed: true
  };

  const outPath = path.resolve(__dirname, "../../evidence/slo-benchmark-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`  Wrote measured SLO report -> ${outPath}`);

  console.log(`\n\x1b[32m[SUCCESS] All load, concurrency, noisy-tenant isolation, worker drain, and privacy-leak gates passed.\x1b[0m`);
}

runLoadTests().catch((err) => {
  console.error(`\x1b[31m[FAILED] Load test failed: ${err.message}\x1b[0m`);
  process.exit(1);
});
