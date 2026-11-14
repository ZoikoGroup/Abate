// backend/tools/test-fast.ts
import assert from "node:assert";
import { CreateOrganizationBody } from "../src/contracts";
import { createDevToken, authenticate } from "../src/domains/tenant/auth";
import { computeRequestHash } from "../src/platform/command";
import { AppError } from "../src/platform/errors";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import jwt from "jsonwebtoken";
import { loadConfig, buildConfig, validateRuntimeConfig, assertRuntimeConfig } from "../src/platform/config";
import { S3ObjectStore, putVerified, readVerified, signV4 } from "../src/platform/object-store";
import { sha256Hex } from "../src/platform/canonical";
import { toErrorResponse } from "../src/platform/errors";
import { classifyRoute, telemetry, RequestRecord } from "../src/platform/telemetry";
import { p95, buildSloReport } from "../src/platform/slo";
import { createSupportToken, authenticateSupport, SUPPORT_AUDIENCE } from "../src/domains/support";

console.log("\x1b[36m=== Abate Task Runner: test-fast (Unit & Policy Invariants) ===\x1b[0m");

let passed = 0;

function it(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        console.log(`  \x1b[32m✔\x1b[0m ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
        process.exit(1);
      });
    }
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function runTests() {
  it("Zod schema strictly rejects unknown / prohibited fields", () => {
    // Normal payload succeeds
    const valid = CreateOrganizationBody.parse({ name: "Litigation Practice" });
    assert.strictEqual(valid.name, "Litigation Practice");

    // Prohibited / injected fields must throw Zod validation error
    assert.throws(() => {
      CreateOrganizationBody.parse({
        name: "Tax Group",
        keystroke_log: "sensitive_keystrokes_prohibited" // Constitutional boundary violation
      });
    });
  });

  it("Canonical request hash is deterministic regardless of key order", () => {
    const hash1 = computeRequestHash({ name: "Practice A", parentId: "123" });
    const hash2 = computeRequestHash({ parentId: "123", name: "Practice A" });
    assert.strictEqual(hash1, hash2);
  });

  it("AppError formats safe codes and safe status codes", () => {
    const err = new AppError("NOT_FOUND");
    assert.strictEqual(err.statusCode, 404);
    assert.strictEqual(err.code, "NOT_FOUND");
    assert.strictEqual(err.message, "Not found.");
  });

  await it("JWT creation and authentication binds tenant identity strictly", async () => {
    const token = createDevToken({
      tenantId: GOLDEN_01.tenantA.id,
      subject: "auth0|user-fast-test",
      role: "RISK_OWNER"
    });

    const identity = await authenticate(`Bearer ${token}`);
    assert.strictEqual(identity.tenantId, GOLDEN_01.tenantA.id);
    assert.strictEqual(identity.subject, "auth0|user-fast-test");
    assert.strictEqual(identity.role, "RISK_OWNER");
  });

  await it("Authentication fails closed on missing or forged token", async () => {
    await assert.rejects(async () => {
      await authenticate("Bearer forged.or.malformed.token");
    });
    await assert.rejects(async () => {
      await authenticate(null);
    });
  });

  // -------------------------------------------------------------
  // B8: SLOs, safe error logs and zero-impersonation support
  // -------------------------------------------------------------

  it("B8 SLO: nearest-rank p95 and route classes match the register targets", () => {
    assert.strictEqual(p95([]), null);
    assert.strictEqual(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
    assert.strictEqual(p95([7]), 7);

    assert.strictEqual(classifyRoute("GET", "/api/v2/organizations"), "READ");
    assert.strictEqual(classifyRoute("POST", "/api/v2/legal-holds"), "WRITE");
    assert.strictEqual(classifyRoute("POST", "/api/v2/releases/query"), "RELEASED_ANALYTICS");
    assert.strictEqual(classifyRoute("GET", "/api/v2/releases/:id"), "RELEASED_ANALYTICS");
    for (const route of ["/api/health", "/api/v2/ops/slo", "/api/v2/auth/token", "UNMATCHED"]) {
      assert.strictEqual(classifyRoute("GET", route), "EXCLUDED", route);
    }
  });

  it("B8 SLO: report flags a p95 breach and counts only 5xx against availability", () => {
    const rec = (routeClass: RequestRecord["routeClass"], durationMs: number, status = 200): RequestRecord => ({
      requestId: Math.random().toString(36), at: new Date().toISOString(), method: routeClass === "READ" ? "GET" : "POST",
      route: `/r/${routeClass}`, routeClass, status, durationMs, errorCode: null, errorFingerprint: null
    });
    const records = [
      ...Array.from({ length: 100 }, () => rec("READ", 20)),
      ...Array.from({ length: 10 }, () => rec("READ", 900)),      // 10/110 slow > 5% => p95 breaches 500ms
      ...Array.from({ length: 50 }, () => rec("WRITE", 30, 409)), // refusals are not outages
      rec("WRITE", 30, 500),
      rec("EXCLUDED", 5000)
    ];
    const report = buildSloReport(records);
    const byClass = Object.fromEntries(report.latency.map(l => [l.routeClass, l]));

    assert.strictEqual(byClass.READ.status, "BREACHED");
    assert.strictEqual(byClass.WRITE.status, "MET");
    assert.strictEqual(byClass.RELEASED_ANALYTICS.status, "NO_DATA");
    assert.strictEqual(report.availability.requests, 161, "EXCLUDED traffic must not count");
    assert.strictEqual(report.availability.serverErrors, 1);
    assert.strictEqual(report.availability.errorBudget.allowedFailures, 0);
    assert.strictEqual(report.availability.errorBudget.remaining, -1);
    assert.strictEqual(report.overall, "BREACHED");
  });

  it("B8 Safe logs: an internal error is logged as a fingerprint, never its message", () => {
    const DECOY = "DECOY_ROW_VALUE_emp-4471";
    const res: any = { locals: { requestId: "req-safe-log" }, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: any[]) => { captured.push(args.map(String).join(" ")); };
    try {
      toErrorResponse(new Error(`duplicate key value violates unique constraint: (subject)=(${DECOY})`), res);
    } finally {
      console.error = original;
    }

    assert.strictEqual(res.code, 500);
    assert.strictEqual(res.body.requestId, "req-safe-log", "Response must carry the request id for support correlation");
    const everything = JSON.stringify({ body: res.body, captured, log: telemetry.errorLog, locals: res.locals });
    assert.ok(!everything.includes(DECOY), "Error content must not reach the response, console or error log");
    assert.strictEqual(res.locals.errorFingerprint?.length, 16);
    assert.ok(telemetry.errorLog.some(e => e.requestId === "req-safe-log"));
  });

  it("B9 Runtime config: local and test keep dev defaults, unknown environments are refused", () => {
    for (const appEnv of ["local", "test"]) {
      const env: NodeJS.ProcessEnv = { APP_ENV: appEnv };
      assert.deepStrictEqual(validateRuntimeConfig(buildConfig(env), env), []);
      assert.strictEqual(buildConfig(env).objectStoreMode, "memory");
    }
    const odd: NodeJS.ProcessEnv = { APP_ENV: "prod" };
    const problems = validateRuntimeConfig(buildConfig(odd), odd);
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].includes("APP_ENV"));
  });

  it("B9 Runtime config: production and staging fail closed on defaults, weak or shared secrets", () => {
    for (const appEnv of ["production", "staging"]) {
      const bare: NodeJS.ProcessEnv = { APP_ENV: appEnv };
      const problems = validateRuntimeConfig(buildConfig(bare), bare).join(" | ");
      for (const name of [
        "AUTH_SECRET", "SUPPORT_AUTH_SECRET", "ACTION_GRANT_SECRET", "OBJECT_STORE_SECRET_KEY",
        "DATABASE_URL_MIGRATOR", "DATABASE_URL_APP", "DATABASE_URL_WORKER", "OBJECT_STORE_ENDPOINT",
        "OBJECT_STORE_ACCESS_KEY", "ABATE_REQUIRE_PG"
      ]) {
        assert.ok(problems.includes(name), `${appEnv} must flag ${name}`);
      }
      assert.throws(() => assertRuntimeConfig(buildConfig(bare), bare), /Refusing to start/);
    }

    const good: NodeJS.ProcessEnv = {
      APP_ENV: "production",
      AUTH_SECRET: "a".repeat(40),
      SUPPORT_AUTH_SECRET: "b".repeat(40),
      ACTION_GRANT_SECRET: "c".repeat(40),
      OBJECT_STORE_SECRET_KEY: "d".repeat(40),
      OBJECT_STORE_ACCESS_KEY: "AKIAEXAMPLEACCESS",
      OBJECT_STORE_ENDPOINT: "https://s3.internal.example",
      DATABASE_URL_MIGRATOR: "postgres://m:x@db.internal:5432/abate",
      DATABASE_URL_APP: "postgres://a:x@db.internal:5432/abate",
      DATABASE_URL_WORKER: "postgres://w:x@db.internal:5432/abate",
      ABATE_REQUIRE_PG: "1"
    };
    assert.deepStrictEqual(validateRuntimeConfig(buildConfig(good), good), []);
    assert.doesNotThrow(() => assertRuntimeConfig(buildConfig(good), good));

    const short = { ...good, AUTH_SECRET: "short" };
    assert.ok(validateRuntimeConfig(buildConfig(short), short).some(p => p.startsWith("AUTH_SECRET") && p.includes("32")));

    const shared = { ...good, SUPPORT_AUTH_SECRET: good.AUTH_SECRET };
    assert.ok(validateRuntimeConfig(buildConfig(shared), shared).some(p => p.includes("must all be different")));

    const sameRole = { ...good, DATABASE_URL_APP: good.DATABASE_URL_MIGRATOR };
    assert.ok(validateRuntimeConfig(buildConfig(sameRole), sameRole).some(p => p.includes("DATABASE_URL_APP must differ")));

    const frozen = { ...good, FIXED_CLOCK: "2026-03-02T09:00:00Z" };
    assert.ok(validateRuntimeConfig(buildConfig(frozen), frozen).some(p => p.startsWith("FIXED_CLOCK")));

    const volatile = { ...good, OBJECT_STORE_MODE: "memory" };
    assert.ok(validateRuntimeConfig(buildConfig(volatile), volatile).some(p => p.startsWith("OBJECT_STORE_MODE")));

    // Problem text names variables only and never leaks a secret value
    const leaky = { ...good, AUTH_SECRET: "x".repeat(10) };
    const text = validateRuntimeConfig(buildConfig(leaky), leaky).join(" ");
    assert.ok(!text.includes("xxxxxxxxxx"));
  });

  await it("B8 Zero impersonation: support and tenant credentials are mutually unusable", async () => {
    const cfg = loadConfig();
    const supportToken = createSupportToken({ operator: "ops.alice" });
    assert.strictEqual(authenticateSupport(`Bearer ${supportToken}`).operator, "ops.alice");

    // Support token cannot authenticate as a tenant principal
    await assert.rejects(() => authenticate(`Bearer ${supportToken}`), (e: any) => e.code === "UNAUTHENTICATED");

    // Tenant token cannot reach the ops plane
    const tenantToken = createDevToken({ tenantId: GOLDEN_01.tenantA.id, subject: "auth0|user-tenant-a-risk-owner" });
    assert.throws(() => authenticateSupport(`Bearer ${tenantToken}`), (e: any) => e.code === "UNAUTHENTICATED");

    // A support-audience token that also names a tenant is refused outright
    const bound = jwt.sign({ sub: "ops.mallory", scope: "platform-support", tenant_id: GOLDEN_01.tenantA.id }, cfg.supportAuthSecret, { issuer: cfg.authIssuer, audience: SUPPORT_AUDIENCE });
    assert.throws(() => authenticateSupport(`Bearer ${bound}`), (e: any) => e.code === "UNAUTHENTICATED");

    // The tenant signing key cannot mint support access
    const forged = jwt.sign({ sub: "ops.mallory", scope: "platform-support" }, cfg.authSecret, { issuer: cfg.authIssuer, audience: SUPPORT_AUDIENCE });
    assert.throws(() => authenticateSupport(`Bearer ${forged}`), (e: any) => e.code === "UNAUTHENTICATED");
  });

  await it("B9 ObjectStore: SigV4 signing, S3 bucket provisioning, putVerified & readVerified integrity", async () => {
    const authHeader = signV4({
      method: "PUT",
      canonicalPath: "/abate-evidence/t/tenant-a/evidence/abc.json",
      canonicalQuery: "",
      headers: {
        host: "127.0.0.1:9000",
        "x-amz-content-sha256": sha256Hex("{}"),
        "x-amz-date": "20261114T100000Z"
      },
      payloadHash: sha256Hex("{}"),
      accessKey: "minioadmin",
      secretKey: "minioadmin_dev_only",
      region: "us-east-1",
      service: "s3",
      amzDate: "20261114T100000Z"
    });
    assert.ok(authHeader.startsWith("AWS4-HMAC-SHA256 Credential=minioadmin/20261114/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="));

    const objects = new Map<string, string>();
    let bucketExists = false;
    const calls: string[] = [];

    const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === "/abate-evidence") {
        if (method === "HEAD") {
          return new Response(null, { status: bucketExists ? 200 : 404 });
        }
        if (method === "PUT") {
          bucketExists = true;
          return new Response(null, { status: 200 });
        }
      }
      if (url.pathname.startsWith("/abate-evidence/")) {
        const key = url.pathname.slice("/abate-evidence/".length);
        if (method === "PUT") {
          objects.set(key, String(init?.body ?? ""));
          return new Response(null, { status: 200 });
        }
        if (method === "GET") {
          const val = objects.get(key);
          return val !== undefined ? new Response(val, { status: 200 }) : new Response(null, { status: 404 });
        }
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const store = new S3ObjectStore(
      {
        objectStoreEndpoint: "http://127.0.0.1:9000",
        objectStoreBucket: "abate-evidence",
        objectStoreRegion: "us-east-1",
        objectStoreAccessKey: "minioadmin",
        objectStoreSecretKey: "minioadmin_dev_only"
      },
      mockFetch,
      () => new Date("2026-11-14T10:00:00.000Z")
    );

    const payload = JSON.stringify({ id: "h-1", title: "Overload hazard" });
    const digest = sha256Hex(payload);
    await putVerified(store, "t/tenant-a/evidence/h-1", payload, digest);
    assert.deepStrictEqual(calls.slice(0, 3), [
      "HEAD /abate-evidence",
      "PUT /abate-evidence",
      "PUT /abate-evidence/t/tenant-a/evidence/h-1"
    ]);

    const got = await readVerified(store, "t/tenant-a/evidence/h-1", digest);
    assert.strictEqual(got, payload);

    // Tamper stored object and assert readVerified rejects
    objects.set("t/tenant-a/evidence/h-1", JSON.stringify({ id: "h-1", title: "TAMPERED" }));
    await assert.rejects(
      () => readVerified(store, "t/tenant-a/evidence/h-1", digest),
      /failed integrity verification/
    );

    // Writing with mismatched digest rejects fail-closed
    await assert.rejects(
      () => putVerified(store, "t/tenant-a/evidence/bad", payload, "0".repeat(64)),
      /failed integrity verification/
    );

    const h = await store.health();
    assert.strictEqual(h.ok, true);
  });

  console.log(`\x1b[32m[SUCCESS] ${passed} fast unit and policy tests passed.\x1b[0m`);
}

runTests();

