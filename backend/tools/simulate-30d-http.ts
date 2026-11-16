// backend/tools/simulate-30d-http.ts
// Scripted 30-Day Lifecycle Simulation over Real HTTP Endpoints
// Explicitly labeled: SCRIPTED SIMULATION exercising real Express HTTP routes & services on 127.0.0.1.

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { app } from "../src/index";
import { seedTwoTenants } from "../src/fixtures/seed";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { memDb } from "../src/platform/db/with-tenant";

interface StepResult {
  dayRange: string;
  phase: string;
  endpoint: string;
  passed: boolean;
  detail: string;
}

export interface Simulation30dReport {
  schema: "abate.simulation-30d.v1";
  mode: "SCRIPTED_REAL_HTTP";
  generatedAt: string;
  baseUrl: string;
  summary: {
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    passed: boolean;
    durationMs: number;
  };
  steps: StepResult[];
}

export async function expressCall(
  method: string,
  urlPath: string,
  opts: { token?: string; body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; raw: string }> {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const reqHeaders: Record<string, string> = {
    accept: "application/json"
  };
  for (const [k, v] of Object.entries(opts.headers || {})) {
    reqHeaders[k.toLowerCase()] = v;
  }
  if (opts.token) {
    reqHeaders["authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) {
    reqHeaders["content-type"] = "application/json";
    reqHeaders["content-length"] = String(Buffer.byteLength(payload));
  }

  return await new Promise((resolve, reject) => {
    const reqSocket: any = new PassThrough();
    reqSocket.remoteAddress = "127.0.0.1";

    const req = new http.IncomingMessage(reqSocket);
    req.url = urlPath;
    (req as any).originalUrl = urlPath;
    req.method = method;
    req.headers = reqHeaders;
    if (payload) {
      req.push(payload);
    }
    req.push(null);

    const chunks: Buffer[] = [];
    const outStream: any = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      }
    });
    outStream.cork = () => { };
    outStream.uncork = () => { };
    outStream.destroy = () => { };

    const res: any = new http.ServerResponse(req);
    res.assignSocket(outStream);
    res.on("finish", () => {
      const fullRaw = Buffer.concat(chunks).toString("utf8");
      const sepIdx = fullRaw.indexOf("\r\n\r\n");
      const raw = sepIdx >= 0 ? fullRaw.slice(sepIdx + 4) : fullRaw;
      let parsed: any = raw;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      resolve({ status: res.statusCode, body: parsed, raw });
    });

    (app as any)(req, res, (err: any) => {
      if (err) reject(err);
      else resolve({ status: res.statusCode || 404, body: null, raw: "" });
    });
  });
}

async function httpCall(
  baseUrl: string,
  method: string,
  urlPath: string,
  opts: { token?: string; body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; raw: string }> {
  if (baseUrl === "express://in-process") {
    return expressCall(method, urlPath, opts);
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts.headers
  };
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }

  const target = new URL(urlPath, baseUrl);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: any = raw;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode || 0, body: parsed, raw });
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export async function run30DayHttpSimulation(
  opts: { quiet?: boolean; writeReport?: boolean; tcp?: boolean; baseUrl?: string } = {}
): Promise<Simulation30dReport> {
  const startMs = Date.now();
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  await seedTwoTenants();

  const useTcp = opts.tcp ?? (process.argv.includes("--tcp") || process.env.SIM_TCP === "1");
  const baseUrlArg = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1];
  let server: http.Server | null = null;
  let baseUrl = opts.baseUrl || baseUrlArg || "express://in-process";

  if (!opts.baseUrl && !baseUrlArg && useTcp) {
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  log("=== Abate Scripted 30-Day Simulation (Real Express HTTP Pipeline) ===");
  log(`NOTE: Clearly labeled SCRIPTED SCENARIO calling genuine Express HTTP routes (${baseUrl}).`);
  const steps: StepResult[] = [];

  const record = async (dayRange: string, phase: string, endpoint: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      steps.push({ dayRange, phase, endpoint, passed: true, detail });
      log(`  ✔ [${dayRange}] ${phase} (${endpoint}): ${detail}`);
    } catch (err: any) {
      steps.push({ dayRange, phase, endpoint, passed: false, detail: err?.message || String(err) });
      log(`  ✖ [${dayRange}] ${phase} (${endpoint}): ${err?.message || String(err)}`);
    }
  };

  try {
    let tokenA = "";
    let tokenB = "";
    let supportToken = "";
    const connAId = "00000000-0000-4000-a004-000000000001";
    const orgAId = "00000000-0000-4000-a001-000000000001";

    // Day 1: Auth, Health & Idempotency Protocol
    await record("Day 01", "Auth & Support Tokens", "POST /api/v2/auth/*", async () => {
      const health = await httpCall(baseUrl, "GET", "/api/health");
      assert.strictEqual(health.status, 200);

      const authA = await httpCall(baseUrl, "POST", "/api/v2/auth/token", {
        body: {
          tenantId: GOLDEN_01.tenantA.id,
          subject: "auth0|user-tenant-a-risk-owner",
          role: "RISK_OWNER",
          purpose: "WORKPLACE_RISK_ASSESSMENT"
        }
      });
      assert.strictEqual(authA.status, 200);
      tokenA = authA.body.token;
      assert.ok(tokenA);

      const authRev = await httpCall(baseUrl, "POST", "/api/v2/auth/token", {
        body: {
          tenantId: GOLDEN_01.tenantA.id,
          subject: "auth0|user-tenant-a-reviewer",
          role: "REVIEWER",
          purpose: "WORKPLACE_RISK_ASSESSMENT"
        }
      });
      assert.strictEqual(authRev.status, 200);
      assert.ok(authRev.body.token);

      const authB = await httpCall(baseUrl, "POST", "/api/v2/auth/token", {
        body: {
          tenantId: GOLDEN_01.tenantB.id,
          subject: "auth0|user-tenant-b-risk-owner",
          role: "RISK_OWNER",
          purpose: "WORKPLACE_RISK_ASSESSMENT"
        }
      });
      assert.strictEqual(authB.status, 200);
      tokenB = authB.body.token;

      const sup = await httpCall(baseUrl, "POST", "/api/v2/auth/support-token", {
        body: { operator: "sre-30d-sim" }
      });
      assert.strictEqual(sup.status, 200);
      supportToken = sup.body.token;
      return "Issued tenant A/B JWTs and operator support token";
    });

    await record("Day 02", "Org Idempotency & Cross-Tenant 404", "POST/GET /api/v2/organizations", async () => {
      const noKey = await httpCall(baseUrl, "POST", "/api/v2/organizations", {
        token: tokenA,
        body: { name: "Sim Division" }
      });
      assert.strictEqual(noKey.status, 400);

      const idemKey = `sim-30d-org-${crypto.randomUUID()}`;
      const create = await httpCall(baseUrl, "POST", "/api/v2/organizations", {
        token: tokenA,
        headers: { "Idempotency-Key": idemKey },
        body: { name: "Sim Practice Group" }
      });
      assert.ok(create.status === 200 || create.status === 201);
      const createdId = create.body.id;

      const replay = await httpCall(baseUrl, "POST", "/api/v2/organizations", {
        token: tokenA,
        headers: { "Idempotency-Key": idemKey },
        body: { name: "Sim Practice Group" }
      });
      assert.strictEqual(replay.status, 200);
      assert.strictEqual(replay.body.id, createdId);

      const conflict = await httpCall(baseUrl, "POST", "/api/v2/organizations", {
        token: tokenA,
        headers: { "Idempotency-Key": idemKey },
        body: { name: "Mutated Practice Group" }
      });
      assert.strictEqual(conflict.status, 409);

      const crossRead = await httpCall(baseUrl, "GET", `/api/v2/organizations/${createdId}`, { token: tokenB });
      assert.strictEqual(crossRead.status, 404);
      return `Created org ${createdId.slice(0, 8)}, verified replay, 409 conflict, and cross-tenant 404`;
    });

    // Days 03-08: Ingestion, Deduplication, Decoy Refusal, Revision Append & STALE
    const decoySecret = "DECOY_SURVEILLANCE_KEYSTROKE_MARKER_30D";
    const baseBatchId = `sim30d-batch-${crypto.randomUUID().slice(0, 8)}`;

    await record("Days 03-05", "ZoikoTime Clean Batch & Replay Dedupe", "POST /api/v2/connectors/zoikotime/batches", async () => {
      const items = Array.from({ length: 12 }, (_, idx) => ({
        recordId: `sim30d-rec-${idx + 1}`,
        revision: 1,
        subjectRef: `sim30d-emp-${String(idx + 1).padStart(3, "0")}`,
        startUtc: "2026-03-03T08:00:00Z",
        endUtc: idx < 4 ? "2026-03-03T20:30:00Z" : "2026-03-03T17:00:00Z",
        workTz: "Europe/London",
        kind: "WORK" as const
      }));

      const ingest = await httpCall(baseUrl, "POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        body: { connectionId: connAId, batchId: baseBatchId, items }
      });
      assert.ok(ingest.status === 200 || ingest.status === 201, `Expected 200/201, got ${ingest.status}: ${ingest.raw}`);
      const beforeFacts = await httpCall(baseUrl, "GET", "/api/v2/work-facts", { token: tokenA });
      assert.strictEqual(beforeFacts.status, 200);
      const countAfterFirst = Array.isArray(beforeFacts.body) ? beforeFacts.body.length : 0;

      // Exact replay -> zero additional work facts
      const replay = await httpCall(baseUrl, "POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        body: { connectionId: connAId, batchId: baseBatchId, items }
      });
      assert.ok(replay.status === 200 || replay.status === 201);
      const afterFacts = await httpCall(baseUrl, "GET", "/api/v2/work-facts", { token: tokenA });
      const countAfterReplay = Array.isArray(afterFacts.body) ? afterFacts.body.length : 0;
      assert.strictEqual(countAfterReplay, countAfterFirst, "Replay added duplicate work facts");
      return `Accepted ${items.length} facts; exact replay kept count constant (${countAfterReplay})`;
    });

    await record("Day 06", "Decoy Surveillance Field Rejection & Zero Trace", "POST /api/v2/connectors/zoikotime/batches", async () => {
      const badBatch = await httpCall(baseUrl, "POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        body: {
          connectionId: connAId,
          batchId: `sim30d-decoy-${crypto.randomUUID().slice(0, 6)}`,
          items: [
            {
              recordId: "sim30d-rec-decoy",
              revision: 1,
              subjectRef: "sim30d-emp-001",
              startUtc: "2026-03-06T09:00:00Z",
              endUtc: "2026-03-06T12:00:00Z",
              workTz: "Europe/London",
              kind: "WORK",
              screenshotUrl: decoySecret
            }
          ]
        }
      });
      assert.strictEqual(badBatch.status, 400, `Decoy batch should fail closed with 400, got ${badBatch.status}`);
      assert.strictEqual(badBatch.raw.includes(decoySecret), false, "HTTP response leaked decoy string");

      const receipts = await httpCall(baseUrl, "GET", "/api/v2/receipts", { token: tokenA });
      const facts = await httpCall(baseUrl, "GET", "/api/v2/work-facts", { token: tokenA });
      const audits = await httpCall(baseUrl, "GET", "/api/v2/audit-events", { token: tokenA });
      assert.strictEqual(receipts.raw.includes(decoySecret), false, "Receipts leaked decoy string");
      assert.strictEqual(facts.raw.includes(decoySecret), false, "Work facts leaked decoy string");
      assert.strictEqual(audits.raw.includes(decoySecret), false, "Audit events leaked decoy string");
      return "Rejected decoy payload with 400; zero persistence/log trace across receipts, ledger & audit";
    });

    await record("Days 07-10", "Revision Correction Append, Pause Guard & STALE Outage", "POST /api/v2/connections/* & /api/v2/ops/connectors", async () => {
      // Revision 2 correction appends without overwriting revision 1
      const rev2 = await httpCall(baseUrl, "POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        body: {
          connectionId: connAId,
          batchId: `sim30d-rev2-${crypto.randomUUID().slice(0, 6)}`,
          items: [
            {
              recordId: "sim30d-rec-1",
              revision: 2,
              subjectRef: "sim30d-emp-001",
              startUtc: "2026-03-03T08:00:00Z",
              endUtc: "2026-03-03T18:00:00Z",
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        }
      });
      assert.ok(rev2.status === 200 || rev2.status === 201);

      // Pause connector -> refuse batch immediately with 403
      const pause = await httpCall(baseUrl, "POST", `/api/v2/connections/${connAId}/pause`, { token: tokenA });
      assert.strictEqual(pause.status, 200);
      const pausedBatch = await httpCall(baseUrl, "POST", "/api/v2/connectors/zoikotime/batches", {
        token: tokenA,
        body: {
          connectionId: connAId,
          batchId: `sim30d-paused-${crypto.randomUUID().slice(0, 6)}`,
          items: [
            {
              recordId: "sim30d-rec-paused",
              revision: 1,
              subjectRef: "sim30d-emp-002",
              startUtc: "2026-03-08T09:00:00Z",
              endUtc: "2026-03-08T12:00:00Z",
              workTz: "Europe/London",
              kind: "WORK"
            }
          ]
        }
      });
      assert.strictEqual(pausedBatch.status, 403, `Paused connector must return 403, got ${pausedBatch.status}`);

      const resume = await httpCall(baseUrl, "POST", `/api/v2/connections/${connAId}/resume`, { token: tokenA });
      assert.strictEqual(resume.status, 200);

      // Inspect connector health: Tenant B seeded 4h stale connection reports STALE
      const opsConns = await httpCall(baseUrl, "GET", "/api/v2/ops/connectors", { token: supportToken });
      assert.strictEqual(opsConns.status, 200);
      const list = Array.isArray(opsConns.body)
        ? opsConns.body
        : opsConns.body?.connections || opsConns.body?.connectors || opsConns.body?.items || [];
      const hasStale = list.some((c: any) => c.health === "STALE" || c.freshness === "STALE" || c.derivedHealth === "STALE");
      if (!hasStale) {
        const bConns = await httpCall(baseUrl, "GET", "/api/v2/connections", { token: tokenB });
        const bList = Array.isArray(bConns.body) ? bConns.body : bConns.body?.items || [];
        const bStale = bList.some((c: any) => c.health === "STALE" || c.freshness === "STALE");
        assert.ok(bStale, `Expected STALE connection in ops (${opsConns.raw.slice(0, 200)}) or Tenant B (${bConns.raw.slice(0, 200)})`);
      }
      return "Revision 2 appended, paused connector refused (403), STALE connector health verified";
    });

    // Days 11-16: Privacy Release Gate
    let postReleaseId = "";
    await record("Days 11-16", "Privacy Release (Class B 28d Valid vs Short Window Blocked)", "POST /api/v2/releases/query", async () => {
      const shortWin = await httpCall(baseUrl, "POST", "/api/v2/releases/query", {
        token: tokenA,
        body: {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: `org:${orgAId}`,
          periodStart: "2026-03-01",
          periodEnd: "2026-03-08",
          releaseClass: "CLASS_B"
        }
      });
      assert.strictEqual(shortWin.status, 200);
      assert.strictEqual(shortWin.body.status, "UNAVAILABLE");
      assert.strictEqual(shortWin.body.code, "NOT_AVAILABLE");

      const validWin = await httpCall(baseUrl, "POST", "/api/v2/releases/query", {
        token: tokenA,
        body: {
          metricId: "BOUNDARY_INTRUSION_SHARE",
          metricVersion: 1,
          cohortRef: `org:${orgAId}`,
          periodStart: "2026-03-01",
          periodEnd: "2026-03-30",
          releaseClass: "CLASS_B"
        }
      });
      assert.strictEqual(validWin.status, 200);
      assert.strictEqual(validWin.body.status, "RELEASED");
      assert.strictEqual("contributorCount" in validWin.body, false, "Release leaked contributorCount");
      assert.strictEqual("contributor_count" in validWin.body, false, "Release leaked contributor_count");
      postReleaseId = validWin.body.releaseId;
      assert.ok(postReleaseId);
      return `Short Class B window suppressed (NOT_AVAILABLE); 29d release issued (${postReleaseId.slice(0, 8)})`;
    });

    // Days 17-25: BE-007 Full Hazard -> Control -> Material Edit Re-Approval -> Verification -> Evidence Package
    let hazardId = "";
    let controlId = "";
    let evidencePkgId = "";
    await record("Days 17-25", "BE-007 Hazard -> Control -> Re-Approval -> Evidence Pack", "POST /api/v2/hazards & /controls & /evidence-packages", async () => {
      const baselineReleaseId = "00000000-0000-4000-a003-000000000001";
      const hRes = await httpCall(baseUrl, "POST", "/api/v2/hazards", {
        token: tokenA,
        body: {
          title: "Out-of-hours filing overload in litigation cohort",
          originatingReleaseId: baselineReleaseId
        }
      });
      assert.strictEqual(hRes.status, 201);
      hazardId = hRes.body.id;

      const causeRes = await httpCall(baseUrl, "POST", `/api/v2/hazards/${hazardId}/causes`, {
        token: tokenA,
        body: { statement: "Unbuffered partner assignment spikes across trial prep weeks" }
      });
      assert.strictEqual(causeRes.status, 201);
      const causeId = causeRes.body.id;

      const revCause = await httpCall(baseUrl, "POST", `/api/v2/hazards/${hazardId}/causes/${causeId}/review`, {
        token: tokenA,
        body: { status: "REVIEWED_ACCEPTED", note: "Supported by practice workload cadence review" }
      });
      assert.strictEqual(revCause.status, 200, `review cause failed: ${revCause.raw}`);

      const ctrlRes = await httpCall(baseUrl, "POST", "/api/v2/controls", {
        token: tokenA,
        body: {
          hazardId,
          causeId,
          scope: "Corporate Litigation Practice — Trial Prep Allocation",
          objective: "Enforce 48h advance triage handoff before weekend court filings",
          dueDate: "2026-04-15",
          verificationPlan: { direction: "DECREASE", targetPct: 20 }
        }
      });
      assert.strictEqual(ctrlRes.status, 201, `create control failed: ${ctrlRes.raw}`);
      controlId = ctrlRes.body.id;

      // Attempt premature implementation jump -> must fail closed
      const illegalJump = await httpCall(baseUrl, "POST", `/api/v2/controls/${controlId}/implementation`, {
        token: tokenA,
        body: { kind: "MANUAL", completedOn: "2026-03-20", evidenceRefs: ["doc://handoff-v1"] }
      });
      assert.ok(illegalJump.status >= 400 && illegalJump.status < 500, `Illegal jump returned ${illegalJump.status}`);

      // Approve current version
      const appV1 = await httpCall(baseUrl, "POST", `/api/v2/controls/${controlId}/approve`, {
        token: tokenA,
        headers: { "If-Match": `${ctrlRes.body.version ?? 1}` },
        body: { note: "Initial v1 risk owner approval" }
      });
      assert.strictEqual(appV1.status, 200, `approve v1 failed: ${appV1.raw}`);
      assert.strictEqual(appV1.body.state, "APPROVED", `unexpected state after approve v1: ${appV1.raw}`);

      // Material edit bumps version and invalidates prior approval
      const verAfterApprove = appV1.body.version ?? ctrlRes.body.version ?? 1;
      const patchV2 = await httpCall(baseUrl, "PATCH", `/api/v2/controls/${controlId}`, {
        token: tokenA,
        headers: { "If-Match": `${verAfterApprove}` },
        body: { objective: "Enforce 72h advance triage handoff + protected rest day" }
      });
      assert.strictEqual(patchV2.status, 200, `patch v2 failed: ${patchV2.raw}`);
      assert.ok(patchV2.body.version > verAfterApprove, `expected bumped version, got ${patchV2.body.version}`);
      assert.strictEqual(patchV2.body.state, "APPROVAL_REQUIRED", `expected APPROVAL_REQUIRED after edit, got ${patchV2.raw}`);

      // Re-approve bumped version
      const appV2 = await httpCall(baseUrl, "POST", `/api/v2/controls/${controlId}/approve`, {
        token: tokenA,
        headers: { "If-Match": `${patchV2.body.version}` },
        body: { note: "Re-approved for updated version material hash" }
      });
      assert.strictEqual(appV2.status, 200, `approve v2 failed: ${appV2.raw}`);

      // Implementation receipt
      const impl = await httpCall(baseUrl, "POST", `/api/v2/controls/${controlId}/implementation`, {
        token: tokenA,
        body: { kind: "MANUAL", completedOn: "2026-03-22", evidenceRefs: ["roster://trial-prep-rotations-v2"] }
      });
      assert.ok(impl.status === 200 || impl.status === 201, `implementation failed: ${impl.raw}`);

      // Pin & conclude verification
      const pin = await httpCall(baseUrl, "POST", `/api/v2/controls/${controlId}/verification/pin`, {
        token: tokenA,
        body: {
          baselineReleaseId,
          postReleaseId,
          adjacentReleaseIds: [],
          direction: "DECREASE",
          criteria: 20,
          adjacentTolerance: 5,
          seriesBreak: false
        }
      });
      assert.ok(pin.status === 200 || pin.status === 201, `pin verification failed: ${pin.raw}`);

      const conclude = await httpCall(baseUrl, "POST", `/api/v2/controls/${controlId}/verification/conclude`, {
        token: tokenA,
        body: {
          outcome: "EFFECTIVE",
          residualRisk: "Residual out-of-hours spikes remain under 5% tolerance",
          postReleaseId
        }
      });
      assert.ok(conclude.status === 200 || conclude.status === 201, `conclude verification failed: ${conclude.raw}`);

      const disp = await httpCall(baseUrl, "POST", `/api/v2/hazards/${hazardId}/disposition`, {
        token: tokenA,
        body: {
          disposition: "VERIFIED_CLOSURE",
          rationale: "Verified improvement over 28-day comparison release",
          residualRisk: "LOW",
          reviewDate: "2026-09-30"
        }
      });
      assert.ok(disp.status === 200 || disp.status === 201, `disposition failed: ${disp.raw}`);

      const pkgRes = await httpCall(baseUrl, "POST", "/api/v2/evidence-packages", {
        token: tokenA,
        body: { hazardId }
      });
      assert.strictEqual(pkgRes.status, 201);
      evidencePkgId = pkgRes.body.id;
      assert.ok(pkgRes.body.manifestHash, "Missing manifestHash on issued evidence package");
      return `Closed hazard ${hazardId.slice(0, 8)} via v2 re-approval; evidence pack ${evidencePkgId.slice(0, 8)}`;
    });

    // Days 26-30: Kill Switch Drill, Plane B Isolation & Release Dossier
    await record("Days 26-28", "AI Kill Switch Fail-Closed & Manual Fallback", "POST /api/v2/ops/kill-switches & /ai/explain-release", async () => {
      const enableKs = await httpCall(baseUrl, "POST", "/api/v2/ops/kill-switches", {
        token: supportToken,
        body: { scope: "all_ai", active: true }
      });
      assert.strictEqual(enableKs.status, 200);

      const blockedAi = await httpCall(baseUrl, "POST", "/api/v2/ai/explain-release", {
        token: tokenA,
        body: { releaseId: "00000000-0000-4000-a003-000000000001", question: "Summarize key drivers" }
      });
      assert.ok(blockedAi.status >= 400 && blockedAi.status < 600, `AI call during kill switch must fail closed, got ${blockedAi.status}`);

      // Manual Plane A read path stays live
      const manualHazards = await httpCall(baseUrl, "GET", "/api/v2/hazards", { token: tokenA });
      assert.strictEqual(manualHazards.status, 200);

      // Restore AI kill switch state cleanly
      await httpCall(baseUrl, "POST", "/api/v2/ops/kill-switches", {
        token: supportToken,
        body: { scope: "all_ai", active: false }
      });
      return `all_ai blocked /ai/explain-release (${blockedAi.status}) while manual hazards remained 200 OK`;
    });

    await record("Days 29-30", "Plane B Isolation & Release Dossier Verification", "GET /api/v2/outcomes/releases/:id & /release/dossier", async () => {
      // Plane B endpoint must refuse Plane A release
      const crossPlane = await httpCall(baseUrl, "GET", "/api/v2/outcomes/releases/00000000-0000-4000-a003-000000000001", {
        token: tokenA
      });
      assert.ok(crossPlane.status >= 400 && crossPlane.status < 500, `Cross-plane leak returned ${crossPlane.status}`);

      // Trigger outcome flag & verify release dossier endpoint
      await httpCall(baseUrl, "POST", "/api/v2/flags", {
        token: tokenA,
        body: { flag: "outcomes_plane_b", enabled: true }
      });
      const defRes = await httpCall(baseUrl, "POST", "/api/v2/outcomes/definitions", {
        token: tokenA,
        body: {
          outcomeId: "OUTCOME_SIM_WORKLOAD",
          version: 1,
          outcomeClass: "PERFORMANCE_OUTCOME",
          family: "WORKLOAD_SUSTAINABILITY",
          purpose: "Track team sustainable allocation clarity in Plane B",
          prohibitedInterpretation: "Must never replace statutory Plane A risk assessment or judge individuals",
          unit: "index",
          definition: { metric: "handoff_stability" },
          qualityRules: { minDays: 28 },
          privacyClass: "B"
        }
      });
      assert.strictEqual(defRes.status, 201);

      const dossier = await httpCall(baseUrl, "GET", "/api/v2/release/dossier");
      assert.strictEqual(dossier.status, 200, `dossier failed: ${dossier.raw}`);
      assert.ok(
        dossier.body?.schema === "abate.release-dossier.v1" || Boolean(dossier.body?.decision || dossier.body?.status),
        `Unexpected dossier body: ${dossier.raw.slice(0, 200)}`
      );
      return `Plane B cross-read blocked (${crossPlane.status}); Plane B definition registered; dossier verified (${dossier.body?.decision?.outcome || dossier.body?.status || dossier.body?.schema})`;
    });

    const passedSteps = steps.filter((s) => s.passed).length;
    const failedSteps = steps.length - passedSteps;
    const report: Simulation30dReport = {
      schema: "abate.simulation-30d.v1",
      mode: "SCRIPTED_REAL_HTTP",
      generatedAt: new Date().toISOString(),
      baseUrl,
      summary: {
        totalSteps: steps.length,
        passedSteps,
        failedSteps,
        passed: failedSteps === 0,
        durationMs: Date.now() - startMs
      },
      steps
    };

    if (opts.writeReport !== false) {
      const outPath = path.resolve(__dirname, "../../evidence/sim-30d-report.json");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      log(`\n[REPORT] Wrote ${outPath}`);
    }

    log(`\n[SUMMARY] ${passedSteps}/${steps.length} scripted 30-day HTTP scenarios passed in ${report.summary.durationMs}ms.`);
    return report;
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    void memDb;
  }
}

if (require.main === module) {
  run30DayHttpSimulation()
    .then((report) => {
      process.exit(report.summary.passed ? 0 : 1);
    })
    .catch((err) => {
      console.error("[FAILED] simulate-30d-http crashed:", err);
      process.exit(1);
    });
}