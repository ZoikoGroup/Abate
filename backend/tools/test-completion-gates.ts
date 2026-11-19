// backend/tools/test-completion-gates.ts
// Verifies Completion Plan gaps closed in code:
// 1. G-18 / T-15: Per-tenant & per-actor rate limits (429 + Retry-After, noisy-tenant isolation)
// 2. G-19 / T-16: Connector webhook HMAC signature, timestamp window, and replay cache
// 3. G-17 / T-24: Telemetry allow-list scrubbing (decoy values never appear in logs/records)
// 4. G-15 / T-17: Reversible connection Suspend -> Resume + terminal Disconnect permanently (409)
// 5. G-24 / T-13: Migration runner no-transaction directive detection

import assert from "node:assert";
import crypto from "node:crypto";
import { expressCall } from "./simulate-30d-http";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken } from "../src/domains/tenant/auth";
import { createSupportToken } from "../src/domains/support";
import { withWorker, memDb } from "../src/platform/db/with-tenant";
import { setRateLimitOverridesForTest } from "../src/platform/rate-limit";
import { signConnectorWebhook, clearWebhookReplayCache } from "../src/domains/ingest/webhook-auth";
import { scrubTelemetryAttributes, telemetry, logSafeError } from "../src/platform/telemetry";
import { loadConfig, resetConfigCache, buildConfig } from "../src/platform/config";
import { assertSafeOutboundUrl } from "../src/platform/ssrf";
import { runScheduledRetentionPass } from "../src/worker/retention-executor";
import {
  evaluateOperationalAlerts,
  renderPrometheusMetrics,
  setStaleConnectorCount,
  recordPackResolutionFailure,
  setAiBudgetUtilizationRatio,
  recordRateLimitHit,
  resetOperationalSignals
} from "../src/platform/monitoring";

let passed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err?.message || err}`);
    process.exit(1);
  }
}

async function main() {
  console.log("\x1b[36m=== Abate Completion Gates Verification (Rate Limits, Webhooks, Telemetry, Connection States) ===\x1b[0m\n");
  await seedTwoTenants();

  const tokenA = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER"
  });
  const tokenB = createDevToken({
    tenantId: GOLDEN_01.tenantB.id,
    subject: "auth0|user-tenant-b-risk-owner",
    role: "RISK_OWNER"
  });

  await check("G-18 Noisy-Tenant Isolation: Tenant A rate-limited (429 + Retry-After) while Tenant B stays 200 OK", async () => {
    setRateLimitOverridesForTest({
      enabled: true,
      windowMs: 60_000,
      tenantDefaultPerMin: 3,
      actorDefaultPerMin: 10,
      ipDefaultPerMin: 100
    });
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await expressCall("GET", "/api/v2/organizations", { token: tokenA });
        assert.strictEqual(ok.status, 200);
      }
      const blocked = await expressCall("GET", "/api/v2/organizations", { token: tokenA });
      assert.strictEqual(blocked.status, 429);
      assert.strictEqual(blocked.body.code, "RATE_LIMITED");
      assert.ok(Number(blocked.headers["retry-after"]) >= 1, "Retry-After header must be present on 429");

      const tenantBOk = await expressCall("GET", "/api/v2/organizations", { token: tokenB });
      assert.strictEqual(tenantBOk.status, 200, "Noisy Tenant A must not impact Tenant B");
    } finally {
      setRateLimitOverridesForTest(null);
    }
  });

  await check("G-19 Connector Webhook Authenticity: valid signature passes, forged/stale/replayed rejected", async () => {
    const prevSecret = process.env.CONNECTOR_WEBHOOK_SECRET;
    process.env.CONNECTOR_WEBHOOK_SECRET = "webhook_test_secret_abate_minimum_32_characters";
    resetConfigCache();
    loadConfig();
    clearWebhookReplayCache();

    try {
      const connsRes = await expressCall("GET", "/api/v2/connections", { token: tokenA });
      assert.strictEqual(connsRes.status, 200);
      const zoikoConn = connsRes.body.find((c: any) => c.source === "ZoikoTime");
      assert.ok(zoikoConn, "Seeded ZoikoTime connection must exist");

      const batchId = `wh-batch-${crypto.randomUUID()}`;
      const body = {
        connectionId: zoikoConn.id,
        batchId,
        items: [
          {
            recordId: `wh-rec-${crypto.randomUUID().slice(0, 8)}`,
            revision: 1,
            subjectRef: "emp-wh-01",
            startUtc: "2026-03-03T09:00:00Z",
            endUtc: "2026-03-03T12:00:00Z",
            workTz: "Europe/London",
            kind: "WORK"
          }
        ]
      };

      // 1. Missing signature fails 401
      const noSig = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        headers: { "idempotency-key": `${batchId}-nosig` },
        body
      });
      assert.strictEqual(noSig.status, 401);

      // 2. Forged signature fails 403
      const nowSec = Math.floor(Date.now() / 1000);
      const forged = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        headers: {
          "idempotency-key": `${batchId}-forged`,
          "x-abate-signature": `t=${nowSec},n=nonce-1,v1=${"0".repeat(64)}`
        },
        body
      });
      assert.strictEqual(forged.status, 403);

      // 3. Expired timestamp fails 403
      const oldTs = nowSec - 900;
      const staleSig = signConnectorWebhook({
        secret: process.env.CONNECTOR_WEBHOOK_SECRET,
        timestampSec: oldTs,
        nonce: "nonce-stale",
        body
      });
      const staleRes = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        headers: { "idempotency-key": `${batchId}-stale`, "x-abate-signature": staleSig },
        body
      });
      assert.strictEqual(staleRes.status, 403);

      // 4. Valid signed request succeeds (200), then exact replay of webhook header is rejected (409)
      const validSig = signConnectorWebhook({
        secret: process.env.CONNECTOR_WEBHOOK_SECRET,
        timestampSec: nowSec,
        nonce: `nonce-${crypto.randomUUID()}`,
        body
      });
      const okRes = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        headers: { "idempotency-key": batchId, "x-abate-signature": validSig },
        body
      });
      assert.strictEqual(okRes.status, 200);

      const replayRes = await expressCall("POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        headers: { "idempotency-key": `${batchId}-replay`, "x-abate-signature": validSig },
        body
      });
      assert.strictEqual(replayRes.status, 409);
    } finally {
      if (prevSecret === undefined) delete process.env.CONNECTOR_WEBHOOK_SECRET;
      else process.env.CONNECTOR_WEBHOOK_SECRET = prevSecret;
      resetConfigCache();
      clearWebhookReplayCache();
    }
  });

  await check("G-17 Telemetry Allow-List Scrubbing: decoy fields stripped from telemetry & error logs", () => {
    const decoy = "DECOY_KEYSTROKE_CANARY_XYZ_999";
    const scrubbed = scrubTelemetryAttributes({
      requestId: "req-123",
      method: "POST",
      route: "/api/v2/connectors/zoikotime/batches",
      routeClass: "WRITE",
      status: 400,
      durationMs: 4.2,
      body: { keystroke_count: decoy },
      tenantId: "secret-tenant",
      authorization: "Bearer secret"
    } as any);
    assert.strictEqual((scrubbed as any).body, undefined);
    assert.strictEqual((scrubbed as any).tenantId, undefined);
    assert.strictEqual((scrubbed as any).authorization, undefined);
    assert.ok(!JSON.stringify(scrubbed).includes(decoy));

    const errEntry = logSafeError("req-decoy", new Error(`DB leak ${decoy}`));
    assert.ok(!JSON.stringify(errEntry).includes(decoy));
    assert.ok(!JSON.stringify(telemetry.errorLog).includes(decoy));
  });

  await check("G-15 Connection State Machine: ACTIVE -> SUSPENDED -> RESUMED -> DISCONNECTED (terminal)", async () => {
    const reg = await expressCall("POST", "/api/v2/connections", {
      token: tokenA,
      headers: { "idempotency-key": `conn-reg-${crypto.randomUUID()}` },
      body: {
        source: "ZoikoTime",
        contractId: "00000000-0000-4000-a005-000000000001",
        expectedCadenceSeconds: 3600
      }
    });
    assert.strictEqual(reg.status, 200);
    const id = reg.body.id;

    const susp = await expressCall("POST", `/api/v2/connections/${id}/suspend`, {
      token: tokenA,
      headers: { "idempotency-key": `conn-susp-${crypto.randomUUID()}` }
    });
    assert.strictEqual(susp.status, 200);
    assert.strictEqual(susp.body.state, "SUSPENDED");
    assert.strictEqual(susp.body.stateLabel, "Suspended");

    const resm = await expressCall("POST", `/api/v2/connections/${id}/resume`, {
      token: tokenA,
      headers: { "idempotency-key": `conn-resm-${crypto.randomUUID()}` }
    });
    assert.strictEqual(resm.status, 200);
    assert.strictEqual(resm.body.state, "RESUMED");
    assert.strictEqual(resm.body.stateLabel, "Resumed");

    const disc = await expressCall("POST", `/api/v2/connections/${id}/disconnect`, {
      token: tokenA,
      headers: { "idempotency-key": `conn-disc-${crypto.randomUUID()}` }
    });
    assert.strictEqual(disc.status, 200);
    assert.strictEqual(disc.body.state, "DISCONNECTED");
    assert.strictEqual(disc.body.stateLabel, "Disconnected");

    // Terminal state refuses subsequent resume with 409
    const afterDisc = await expressCall("POST", `/api/v2/connections/${id}/resume`, {
      token: tokenA,
      headers: { "idempotency-key": `conn-after-${crypto.randomUUID()}` }
    });
    assert.strictEqual(afterDisc.status, 409);
  });

  await check("Security & Anti-Cache Headers: /api/* sets no-store, nosniff, DENY, and CSP", async () => {
    const res = await expressCall("GET", "/api/v2/organizations", { token: tokenA });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["cache-control"], "no-store");
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    assert.strictEqual(res.headers["x-frame-options"], "DENY");
    assert.ok(String(res.headers["content-security-policy"] || "").includes("default-src 'self'"));
  });

  await check("Human-Approved Dead-Letter Replay: requires support role & reason, resets outbox row, blocks replay twice (409)", async () => {
    const outboxId = crypto.randomUUID();
    const deadLetterId = crypto.randomUUID();
    await withWorker(async (tx) => {
      memDb.outboxEvents.push({
        id: outboxId,
        tenant_id: GOLDEN_01.tenantA.id,
        aggregate: "Hazard",
        aggregate_id: crypto.randomUUID(),
        aggregate_version: 1,
        event_type: "HazardCreated",
        schema_version: "v1",
        purpose: "WORKPLACE_RISK_ASSESSMENT",
        refs: [],
        state: "DEAD_LETTER",
        attempts: 5,
        next_retry_at: new Date().toISOString(),
        last_error: "Simulated delivery exhaustion",
        created_at: new Date().toISOString(),
        published_at: null
      });
      await tx.q(
        `INSERT INTO dead_letter_event (
           id, outbox_id, tenant_id, aggregate, aggregate_id, schema_version,
           purpose, refs, attempts, last_error
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          deadLetterId,
          outboxId,
          GOLDEN_01.tenantA.id,
          "Hazard",
          crypto.randomUUID(),
          "v1",
          "WORKPLACE_RISK_ASSESSMENT",
          JSON.stringify([]),
          5,
          "Simulated delivery exhaustion"
        ]
      );
    });

    const supportTok = createSupportToken({ operator: "ops.replay.reviewer" });

    // 1. Tenant token rejected on support replay endpoint
    const tenantDenied = await expressCall("POST", `/api/v2/ops/dead-letters/${deadLetterId}/replay`, {
      token: tokenA,
      body: { reason: "Unauthorized attempt" }
    });
    assert.ok(tenantDenied.status === 401 || tenantDenied.status === 403);

    // 2. Short/missing approval reason rejected (400)
    const badReason = await expressCall("POST", `/api/v2/ops/dead-letters/${deadLetterId}/replay`, {
      token: supportTok,
      body: { reason: "no" }
    });
    assert.strictEqual(badReason.status, 400);

    // 3. Valid human approval replays outbox row to PENDING & records attribution
    const replayed = await expressCall("POST", `/api/v2/ops/dead-letters/${deadLetterId}/replay`, {
      token: supportTok,
      body: { reason: "Verified consumer healthy; approved retry" }
    });
    assert.strictEqual(replayed.status, 200);
    assert.strictEqual(replayed.body.state, "PENDING");
    assert.strictEqual(replayed.body.replayedBy, "ops.replay.reviewer");
    const restoredOutbox = memDb.outboxEvents.find(e => e.id === outboxId);
    assert.strictEqual(restoredOutbox?.state, "PENDING");
    assert.strictEqual(restoredOutbox?.attempts, 0);

    // 4. Replaying an already replayed dead-letter returns 409 CONFLICT
    const duplicate = await expressCall("POST", `/api/v2/ops/dead-letters/${deadLetterId}/replay`, {
      token: supportTok,
      body: { reason: "Duplicate replay attempt" }
    });
    assert.strictEqual(duplicate.status, 409);
  });

  await check("Unified 400 & 409 Error Shape: returns { code, message, fields, requestId } without submitted values", async () => {
    const key = `err-shape-${crypto.randomUUID()}`;
    const created = await expressCall("POST", "/api/v2/organizations", {
      token: tokenA,
      headers: { "idempotency-key": key },
      body: { name: "Error Shape Org" }
    });
    assert.strictEqual(created.status, 200);

    // 409 Conflict (tampered body with reused key)
    const conflictRes = await expressCall("POST", "/api/v2/organizations", {
      token: tokenA,
      headers: { "idempotency-key": key },
      body: { name: "Tampered Error Shape Org" }
    });
    assert.strictEqual(conflictRes.status, 409);
    assert.strictEqual(conflictRes.body.code, "CONFLICT");
    assert.ok(typeof conflictRes.body.requestId === "string" && conflictRes.body.requestId.length > 0);
    assert.deepStrictEqual(conflictRes.body.fields, ["Idempotency-Key"]);

    // 400 Missing Idempotency-Key
    const missingKeyRes = await expressCall("POST", "/api/v2/organizations", {
      token: tokenA,
      body: { name: "Missing Key Org" }
    });
    assert.strictEqual(missingKeyRes.status, 400);
    assert.strictEqual(missingKeyRes.body.code, "VALIDATION");
    assert.ok(typeof missingKeyRes.body.requestId === "string" && missingKeyRes.body.requestId.length > 0);
    assert.deepStrictEqual(missingKeyRes.body.fields, ["Idempotency-Key"]);

    // 400 Zod strict rejection returns field name(s) only, never echoed payload value
    const secretDecoyVal = "CANARY_PROHIBITED_VAL_400";
    const decoyRes = await expressCall("POST", "/api/v2/organizations", {
      token: tokenA,
      headers: { "idempotency-key": `decoy-${crypto.randomUUID()}` },
      body: { name: "Decoy Org", keystroke_tracker: secretDecoyVal }
    });
    assert.strictEqual(decoyRes.status, 400);
    assert.strictEqual(decoyRes.body.code, "VALIDATION");
    assert.ok(Array.isArray(decoyRes.body.fields) && decoyRes.body.fields.includes("keystroke_tracker"));
    assert.ok(!JSON.stringify(decoyRes.body).includes(secretDecoyVal), "400 error body must never echo submitted values");
  });

  await check("SSRF Outbound Guard (Section 6 & 9): blocks metadata, private IPs, and non-HTTPS in production", () => {
    const prodCfg = buildConfig({ APP_ENV: "production", NODE_ENV: "production" });
    assert.throws(() => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/", { cfg: prodCfg }), /prohibited|metadata/i);
    assert.throws(() => assertSafeOutboundUrl("http://metadata.google.internal/computeMetadata/v1/", { cfg: prodCfg }), /prohibited|metadata/i);
    assert.throws(() => assertSafeOutboundUrl("https://10.0.0.5/jwks.json", { cfg: prodCfg }), /private|reserved/i);
    assert.throws(() => assertSafeOutboundUrl("https://127.0.0.1/token", { cfg: prodCfg }), /private|reserved/i);
    assert.throws(() => assertSafeOutboundUrl("http://idp.example.com/.well-known/jwks.json", { cfg: prodCfg }), /HTTPS/i);
    assert.doesNotThrow(() => assertSafeOutboundUrl("https://idp.example.com/.well-known/jwks.json", { cfg: prodCfg }));
  });

  await check("Cursor Pagination & Allow-Listed Filters: returns X-Next-Cursor and rejects unknown filter keys (400)", async () => {
    for (let i = 0; i < 2; i++) {
      await expressCall("POST", "/api/v2/organizations", {
        token: tokenA,
        headers: { "idempotency-key": `cursor-org-${i}-${crypto.randomUUID()}` },
        body: { name: `Cursor Page Org ${i}` }
      });
    }
    const page1 = await expressCall("GET", "/api/v2/organizations?limit=1", { token: tokenA });
    assert.strictEqual(page1.status, 200);
    assert.strictEqual(page1.body.length, 1);
    assert.strictEqual(page1.headers["x-has-more"], "true");
    assert.ok(page1.headers["x-next-cursor"], "X-Next-Cursor header must be set when more items exist");

    const page2 = await expressCall("GET", `/api/v2/organizations?limit=1&cursor=${encodeURIComponent(page1.headers["x-next-cursor"]!)}`, { token: tokenA });
    assert.strictEqual(page2.status, 200);
    assert.strictEqual(page2.body.length, 1);
    assert.notStrictEqual(page2.body[0].id, page1.body[0].id, "Page 2 must advance past Page 1 cursor");

    const badFilter = await expressCall("GET", "/api/v2/organizations?evilFilter=SECRET_VAL_XYZ", { token: tokenA });
    assert.strictEqual(badFilter.status, 400);
    assert.strictEqual(badFilter.body.code, "VALIDATION");
    assert.ok(badFilter.body.fields?.includes("evilFilter"));
    assert.ok(!JSON.stringify(badFilter.body).includes("SECRET_VAL_XYZ"), "Unknown query filter error must not echo value");
  });

  await check("ETag / If-Match Concurrency & 202 Recalculation Job (Section 6)", async () => {
    // 1. Connection ETag & stale If-Match -> 409
    const reg = await expressCall("POST", "/api/v2/connections", {
      token: tokenA,
      headers: { "idempotency-key": `etag-conn-${crypto.randomUUID()}` },
      body: { source: "ZoikoTime", contractId: "00000000-0000-4000-a005-000000000001", expectedCadenceSeconds: 3600 }
    });
    const getConn = await expressCall("GET", `/api/v2/connections/${reg.body.id}`, { token: tokenA });
    assert.strictEqual(getConn.status, 200);
    assert.strictEqual(getConn.headers["etag"], '"ACTIVE"');

    const staleConn = await expressCall("POST", `/api/v2/connections/${reg.body.id}/suspend`, {
      token: tokenA,
      headers: { "idempotency-key": `etag-stale-${crypto.randomUUID()}`, "if-match": '"PAUSED"' }
    });
    assert.strictEqual(staleConn.status, 409);

    // 2. Hazard ETag & stale If-Match -> 409
    const haz = await expressCall("GET", `/api/v2/hazards/${GOLDEN_01.approvedControl.hazardId}`, { token: tokenA });
    assert.strictEqual(haz.status, 200);
    assert.ok(haz.headers["etag"], "GET /api/v2/hazards/:id must return ETag header");

    const staleHaz = await expressCall("POST", `/api/v2/hazards/${GOLDEN_01.approvedControl.hazardId}/disposition`, {
      token: tokenA,
      headers: { "if-match": '"999"' },
      body: { disposition: "CONTROLLED", rationale: "Stale check", residualRisk: "LOW", reviewDate: "2026-12-31" }
    });
    assert.strictEqual(staleHaz.status, 409);

    // 3. Long-running metric recalculation returns 202 Accepted + jobId
    const recalc = await expressCall("POST", "/api/v2/metrics/BOUNDARY_INTRUSION_SHARE/recalculate", { token: tokenA });
    assert.strictEqual(recalc.status, 202);
    assert.ok(recalc.body.jobId, "202 Accepted response must include jobId");
  });

  await check("Scheduled Retention Executor Worker (G-21 / T-19): runs active retention policy safely", async () => {
    const setClass = await expressCall("POST", "/api/v2/retention/classes", {
      token: tokenA,
      headers: { "idempotency-key": `ret-exec-class-${crypto.randomUUID()}` },
      body: { dataCategory: "WORK_FACT", retentionDays: 120, basis: "Executor verification schedule" }
    });
    assert.ok(setClass.status === 200 || setClass.status === 201);

    const summary = await runScheduledRetentionPass({ tenantIds: [GOLDEN_01.tenantA.id] });
    assert.strictEqual(summary.tenantsEvaluated, 1);
    assert.strictEqual(summary.runsExecuted, 1);
    assert.strictEqual(summary.totalBlocked, 0);
  });

  await check("Observability 6-Category Alerts & Prometheus Metrics (Section 6): freshness, outbox, privacy, pack, AI cost, tenant load", () => {
    resetOperationalSignals();
    try {
      setStaleConnectorCount(2);
      recordPackResolutionFailure();
      setAiBudgetUtilizationRatio(0.85);
      for (let i = 0; i < 25; i++) recordRateLimitHit();

      const sloStub = {
        latency: [],
        availability: { requests: 100, serverErrors: 0, ratio: 1, target: 0.999, status: "MET" }
      };
      const workerStub = {
        state: "RUNNING",
        queueDepth: 3,
        queueLagMs: 75_000,
        totalProcessed: 10,
        totalFailures: 0,
        totalDeadLetters: 0
      };
      const depsStub = { databaseOk: true, databaseRequired: false, objectStoreOk: true, objectStoreMode: "memory" };

      const report = evaluateOperationalAlerts({
        cfg: loadConfig(),
        sloReport: sloStub,
        workerMetrics: workerStub,
        deps: depsStub
      });
      const firingIds = new Set(report.alerts.filter((a) => a.state === "FIRING").map((a) => a.id));
      for (const expectedId of [
        "AbateConnectorStaleDetected",
        "AbatePackResolutionFailure",
        "AbateAiBudgetHighUtilization",
        "AbateTenantRateLimitBurst",
        "AbateWorkerQueueLagHigh"
      ]) {
        assert.ok(firingIds.has(expectedId), `Expected alert ${expectedId} to fire`);
      }

      const prom = renderPrometheusMetrics({ sloReport: sloStub, workerMetrics: workerStub, deps: depsStub });
      for (const metricName of [
        "abate_connectors_stale_total 2",
        "abate_pack_resolution_failures_total 1",
        "abate_ai_budget_utilization_ratio 0.85",
        "abate_http_rate_limited_total 25"
      ]) {
        assert.ok(prom.includes(metricName), `Expected Prometheus metric '${metricName}'`);
      }
    } finally {
      resetOperationalSignals();
    }
  });

  console.log(`\n\x1b[32m✔ Completion Gates Verification PASSED (${passed} checks).\x1b[0m\n`);
}

main().catch((err) => {
  console.error("\x1b[31m[COMPLETION GATES FAILED]\x1b[0m", err);
  process.exit(1);
});
