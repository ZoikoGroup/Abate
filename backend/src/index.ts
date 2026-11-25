// backend/src/index.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import compression from "compression";
import { z } from "zod";
import { loadConfig, isHardenedEnv } from "./platform/config";
import { getObjectStore } from "./platform/object-store";
import { readCookieFromHeader, SESSION_COOKIE_NAME } from "./platform/oidc";
import { recordPrivacyOutcome, renderPrometheusMetrics } from "./platform/monitoring";
import { toErrorResponse, AppError } from "./platform/errors";
import { runCommand, computeRequestHash } from "./platform/command";
import { authenticateSupport } from "./domains/support";
import { openApiSpec, CreateOrganizationBody, SemanticQueryV1 } from "./contracts";
import { GOLDEN_01 } from "./fixtures/golden01";
import { authenticate, resolveActor, authorize } from "./domains/tenant/auth";
import { createOrganization, getOrganization, listOrganizations, getTenant } from "./domains/tenant/commands";
import { rateLimitMiddleware } from "./platform/rate-limit";
import { applyCursorPagination, setPaginationHeaders, validateAllowedQueryParams } from "./platform/pagination";
import { compileRelease, getRelease } from "./domains/privacy";
import { resolveTenantSectorProfile, setTenantSectorSetting, describeSectorScope } from "./domains/lifecycle";
import { SECTOR_KEY_PATTERN } from "./domains/lifecycle/sector-pack";
import { telemetry, telemetryMiddleware, classifyRoute } from "./platform/telemetry";
import { buildSloReport } from "./platform/slo";
import { withTenant, isPostgresRequired } from "./platform/db/with-tenant";
import { getWorkerMetrics } from "./worker/daemon";
import { drainOnce } from "./worker/outbox-publisher";
import { seedTwoTenants } from "./fixtures/seed";
import { getHeader, parseLimit, checkPgHealthSafe } from "./routes/helpers";
import { registerAuthRoutes } from "./routes/auth";
import { registerIngestRoutes } from "./routes/ingest";
import { registerControlRoutes } from "./routes/control";
import { registerLifecycleRoutes } from "./routes/lifecycle";
import { registerOpsRoutes } from "./routes/ops";
import { registerAiActionRoutes } from "./routes/ai-actions";
import { registerPlanesRoutes } from "./routes/planes";
import { registerSectorWorkRoutes } from "./routes/sector-work";

const cfg = loadConfig();
const app = express();

// B8: per-request id, latency and status for SLOs (route templates only, no content)
app.use(telemetryMiddleware);

app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// Per-tenant, per-actor, and per-IP rate limiting with stricter tiers for AI, exports, and ingestion (G-18 / T-15).
app.use(rateLimitMiddleware);

// Pilot structured JSON request logging (B8-safe: routeClass only, zero tenant IDs/PII)
app.use((req: Request, res: Response, next: NextFunction) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const runtimeCfg = loadConfig();
    if (!runtimeCfg.structuredLogs) return;
    const durationMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? "error" : "info",
      at: new Date().toISOString(),
      requestId: res.locals.requestId || null,
      method: req.method,
      routeClass: classifyRoute(req.method, req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : req.path),
      status: res.statusCode,
      durationMs
    }));
  });
  next();
});

app.use(cors({
  origin: cfg.clientUrl,
  credentials: true,
  exposedHeaders: ["ETag", "X-Next-Cursor", "X-Has-More", "X-Request-Id", "Retry-After"]
}));

app.use(compression());
// Security & anti-cache headers (Completion Plan Section 6 & 7.1)
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
// A schema-max ingest batch (1000 items) is larger than express's 100kb default
app.use(express.json({ limit: "2mb" }));

// Translate HttpOnly abate_session cookies into internal CookieSession credentials for tenant routes.
// Client-supplied CookieSession headers are stripped first, and /api/v2/ops/* never consumes tenant cookies.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("CookieSession ")) {
    delete req.headers.authorization;
  }
  if (!req.headers.authorization && !req.path.startsWith("/api/v2/ops/") && req.headers.cookie) {
    const cookieToken = readCookieFromHeader(req.headers.cookie, SESSION_COOKIE_NAME);
    if (cookieToken) {
      const runtimeCfg = loadConfig();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        const origin = getHeader(req, "origin");
        if (origin && origin !== runtimeCfg.clientUrl && isHardenedEnv(runtimeCfg.appEnv)) {
          return toErrorResponse(new AppError("FORBIDDEN", "Cross-origin state mutation refused."), res);
        }
      }
      req.headers.authorization = `CookieSession ${cookieToken}`;
    }
  }
  next();
});

// Initialize fixtures for development environment
if (cfg.appEnv === "local" || cfg.appEnv === "test") {
  seedTwoTenants({ clock: new Date(cfg.fixedClock) }).catch(err => {
    console.warn("[Init] Local fixture seeding notice:", err.message);
  });
}


// -------------------------------------------------------------
// Health and Metadata Endpoints
// -------------------------------------------------------------

app.get("/api/health", async (_req: Request, res: Response) => {
  const runtimeCfg = loadConfig();
  const store = getObjectStore(runtimeCfg);
  const [objectStoreHealth, pgOk] = await Promise.all([store.health(), checkPgHealthSafe()]);
  const workerMetrics = getWorkerMetrics();
  const pgRequired = isPostgresRequired() || isHardenedEnv(runtimeCfg.appEnv);
  const storeRequired = runtimeCfg.objectStoreMode === "s3" || isHardenedEnv(runtimeCfg.appEnv);
  const overallOk = (!pgRequired || pgOk) && (!storeRequired || objectStoreHealth.ok) && objectStoreHealth.ok;

  res.status(overallOk ? 200 : 503).json({
    status: overallOk ? "ok" : "degraded",
    app: "Zoiko Abate",
    version: "1.0.0",
    environment: runtimeCfg.appEnv,
    database: {
      mode: pgOk ? "postgres" : "memory",
      required: pgRequired,
      ok: pgOk
    },
    objectStore: {
      mode: store.mode,
      ok: objectStoreHealth.ok,
      detail: objectStoreHealth.detail
    },
    worker: {
      state: workerMetrics.state,
      queueDepth: workerMetrics.queueDepth,
      totalDeadLetters: workerMetrics.totalDeadLetters,
      outboxPrunedTotal: workerMetrics.outboxPrunedTotal ?? 0
    },
    timestamp: new Date().toISOString(),
    constitutionalBoundaries: {
      individualScoring: "PROHIBITED",
      surveillanceMining: "PROHIBITED",
      clinicalDependency: "PROHIBITED",
      privacyGate: "CLASS_B_C_MIN_10_CONTRIBUTORS",
      planeSeparation: "PLANE_B_CANNOT_MUTATE_PLANE_A",
      supportModel: "ZERO_IMPERSONATION_SIGNED_DIAGNOSTICS"
    }
  });
});

// B8-safe Prometheus metrics endpoint (zero tenant IDs, subjects, or PII)
app.get("/metrics", async (req: Request, res: Response) => {
  try {
    const runtimeCfg = loadConfig();
    const authHeader = getHeader(req, "authorization");
    if (runtimeCfg.metricsAuthToken) {
      if (authHeader !== `Bearer ${runtimeCfg.metricsAuthToken}`) {
        await authenticateSupport(authHeader);
      }
    } else if (isHardenedEnv(runtimeCfg.appEnv)) {
      await authenticateSupport(authHeader);
    }

    const [objectStoreHealth, pgOk] = await Promise.all([
      getObjectStore(runtimeCfg).health(),
      checkPgHealthSafe()
    ]);
    const text = renderPrometheusMetrics({
      sloReport: buildSloReport(telemetry.snapshot()),
      workerMetrics: getWorkerMetrics(),
      deps: {
        databaseOk: pgOk,
        databaseRequired: isPostgresRequired(),
        objectStoreOk: objectStoreHealth.ok,
        objectStoreMode: runtimeCfg.objectStoreMode
      }
    });
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(text);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/info", (_req: Request, res: Response) => {
  res.status(200).json({
    app: "Zoiko Abate",
    version: "1.0.0",
    description: "Organizational work-design and psychosocial-risk infrastructure.",
    architecture: {
      framework: "TypeScript / Node.js Modular Monolith",
      databaseRoles: "Separate abate_migrator and restricted abate_app (NOSUPERUSER, NOBYPASSRLS)",
      isolation: "PostgreSQL Forced Row-Level Security with transaction-local context",
      reliability: "Single command pipeline with Idempotency, Append-Only Audit, and Outbox"
    },
    domains: {
      S01: "Tenant, access, organization (Active)",
      S02_S03: "Ingestion / work-state ledger",
      S04_S06: "Measurement / Privacy Release",
      S05_S07: "Hazards / interventions",
      S08_S09: "Bounded AI / action execution",
      S10: "Governance and evidence",
      S11_S12: "Commercial / lifecycle (jurisdiction packs, retention, legal hold)"
    }
  });
});

// Canonical Contract Registry (OpenAPI 3.1)
// The spec is static: serialize once instead of on every request
const openApiBody = JSON.stringify(openApiSpec);
app.get("/api/v2/contracts/openapi.json", (_req: Request, res: Response) => {
  res.status(200).type("application/json").send(openApiBody);
});

// Interactive Swagger UI Documentation Explorer
const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zoiko Abate API Contract Explorer (OpenAPI 3.1)</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" integrity="sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn" crossorigin="anonymous" />
  <style>
    body { margin: 0; padding: 0; background: #FAFAFA; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .abate-header {
      background: linear-gradient(135deg, #1E1B4B 0%, #312E81 100%);
      color: #FFFFFF;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .abate-title { font-size: 1.15rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
    .abate-badge { background: #E26D5A; color: #FFF; font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600; }
    .swagger-ui .topbar { display: none !important; }
  </style>
</head>
<body>
  <div class="abate-header">
    <div class="abate-title">
      <span>ZOIKO ABATE</span>
      <span class="abate-badge">CANONICAL CONTRACT REGISTRY</span>
    </div>
    <div style="font-size: 0.8rem; opacity: 0.85;">
      OpenAPI 3.1 &bull; Two-Plane Authority Model &bull; Specification ZAB-ENG-001
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" integrity="sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep" crossorigin="anonymous"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/api/v2/contracts/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`;

app.get(["/docs", "/swagger", "/api-docs"], (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(swaggerHtml);
});


registerAuthRoutes(app);

// -------------------------------------------------------------

// List active tenants for workspace switching (Guide §D.1)
app.get("/api/v2/tenants", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    if (cfg.appEnv !== "local" && cfg.appEnv !== "test") {
      // Only the caller's own tenant: the fixture list below names a second tenant and its cohort size
      const own = await getTenant({ who, actor });
      return res.status(200).json({ items: [{ id: own.id, tenantId: own.id, name: own.name, region: own.region, state: "ACTIVE" }] });
    }
    const items = [
      {
        id: GOLDEN_01.tenantA.id,
        tenantId: GOLDEN_01.tenantA.id,
        name: GOLDEN_01.tenantA.name,
        region: GOLDEN_01.tenantA.region,
        state: "ACTIVE",
        cohortSize: GOLDEN_01.tenantA.cohortSize
      },
      {
        id: GOLDEN_01.tenantB.id,
        tenantId: GOLDEN_01.tenantB.id,
        name: GOLDEN_01.tenantB.name,
        region: GOLDEN_01.tenantB.region,
        state: "ACTIVE",
        cohortSize: GOLDEN_01.tenantB.cohortSize
      }
    ];
    res.status(200).json({ items });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/tenants/current", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    const tenant = await getTenant({ who, actor });
    res.status(200).json(tenant);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Active Sector Profile & Vocabulary for the caller's tenant (Sector-Neutral Core Contract)
app.get("/api/v2/tenant/sector-profile", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    const profile = await withTenant(who.tenantId, async (tx) => resolveTenantSectorProfile(tx, who.tenantId));
    res.status(200).json(profile);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

const SetTenantSectorProfileBody = z.object({
  // Validated against the sector pack registry in setTenantSectorSetting.
  sectorKey: z.string().regex(SECTOR_KEY_PATTERN, "sectorKey must be an upper-case sector key such as LEGAL."),
  packKey: z.string().min(2).max(120)
}).strict();

app.put("/api/v2/tenant/sector-profile", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    const idempotencyKey = getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key");
    if (!idempotencyKey) {
      throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.", undefined, undefined, ["Idempotency-Key"]);
    }
    const input = SetTenantSectorProfileBody.parse(req.body);
    authorize(actor, "tenant.sector_profile.set", undefined, who.purpose);
    const result = await runCommand({
      tenantId: who.tenantId,
      operation: "tenant.sector_profile.set",
      idempotencyKey,
      requestHash: computeRequestHash(input),
      actor,
      body: async (tx) => {
        await setTenantSectorSetting(tx, {
          tenantId: who.tenantId,
          sectorKey: input.sectorKey,
          packKey: input.packKey,
          updatedBy: actor.principalId
        });
        const profile = await resolveTenantSectorProfile(tx, who.tenantId);
        return {
          result: profile,
          audit: {
            purpose: who.purpose,
            command: "tenant.sector_profile.set",
            resourceType: "tenant_sector_setting",
            resourceId: who.tenantId,
            result: "SUCCESS" as const,
            evidenceRefs: [`sector_pack/${input.packKey}`]
          },
          events: [{
            aggregate: "tenant_sector_setting",
            aggregateId: who.tenantId,
            aggregateVersion: 1,
            eventType: "tenant.sector_profile.updated",
            schemaVersion: "v1.0",
            purpose: who.purpose,
            refs: [`sector_pack/${input.packKey}`]
          }]
        };
      }
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Inspect single tenant profile with strict boundary enforcement
app.get("/api/v2/tenants/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    if (req.params.id !== who.tenantId) {
      throw new AppError("FORBIDDEN", "Tenant boundary violation: access to foreign tenant profile is prohibited.");
    }
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    const tenant = await getTenant({ who, actor });
    res.status(200).json(tenant);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Create organization (Thin route handler: authenticate -> resolve -> parse Zod -> check idempotency-key -> command)
app.post("/api/v2/organizations", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    // Strict schema validation: rejects unknown or prohibited fields immediately
    const body = CreateOrganizationBody.parse(req.body);

    const idempotencyKey = getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key");
    if (!idempotencyKey) {
      throw new AppError(
        "VALIDATION",
        "Header 'Idempotency-Key' is required for all state-changing commands.",
        undefined,
        undefined,
        ["Idempotency-Key"]
      );
    }

    const result = await createOrganization({
      who,
      actor,
      body,
      idempotencyKey
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/organizations", async (req: Request, res: Response) => {
  try {
    validateAllowedQueryParams(req, ["limit", "cursor"]);
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    const orgs = await listOrganizations({ who, actor });
    const page = applyCursorPagination(orgs, {
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit: parseLimit(req, 200, 500),
      getKey: (o: any) => String(o.id)
    });
    setPaginationHeaders(res, page);
    res.status(200).json(page.items);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/organizations/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    const orgId = String(req.params.id);

    const org = await getOrganization({ who, actor, orgId });
    res.status(200).json(org);
  } catch (err) {
    // Safe error response: foreign tenant and non-existent yield identical 404 NOT_FOUND
    toErrorResponse(err, res);
  }
});

// Audit events query for caller's tenant
app.get("/api/v2/audit-events", async (req: Request, res: Response) => {
  try {
    validateAllowedQueryParams(req, ["limit", "cursor", "command", "resourceType"]);
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    // RLS scopes the audit trail to the authenticated tenant
    const auditLimit = parseLimit(req, 200, 1000);
    const filterCommand = typeof req.query.command === "string" ? req.query.command : undefined;
    const filterResourceType = typeof req.query.resourceType === "string" ? req.query.resourceType : undefined;
    const rawEvents = await withTenant(who.tenantId, async (tx) =>
      (await tx.q(`SELECT * FROM audit_event ORDER BY occurred_at DESC LIMIT 1000`)).rows
    );
    const filtered = rawEvents.filter((e: any) => {
      if (filterCommand && e.command !== filterCommand) return false;
      if (filterResourceType && e.resource_type !== filterResourceType) return false;
      return true;
    });
    const page = applyCursorPagination(filtered, {
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit: auditLimit,
      getKey: (e: any) => String(e.id)
    });
    setPaginationHeaders(res, page);
    res.status(200).json(page.items);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Worker Outbox Drainage Endpoint
app.post("/api/v2/outbox/drain", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    const report = await drainOnce();
    res.status(200).json({
      status: "ok",
      report,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});


registerIngestRoutes(app);

// -------------------------------------------------------------

// Metric definitions list
app.get("/api/v2/metrics/definitions", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date(), who.role);
    let rawDefs: any[] = await withTenant(who.tenantId, async (tx) => (await tx.q("SELECT * FROM metric_definition")).rows);
    if (rawDefs.length === 0) {
      rawDefs = [{
        id: "BOUNDARY_INTRUSION_SHARE",
        metric_id: "BOUNDARY_INTRUSION_SHARE",
        name: "Boundary Intrusion Share",
        hazard_domain: "Working Time Quality & Rest Deficits",
        version: 1,
        formula_id: "boundaryIntrusionShare",
        contributor_floor: 10,
        min_window_days: 28,
        approved_at: new Date().toISOString()
      }];
    }
    const defs = rawDefs.map(d => {
      const defObj = typeof d.definition === "string"
        ? (() => { try { return JSON.parse(d.definition); } catch { return {}; } })()
        : (d.definition && typeof d.definition === "object" ? d.definition : {});
      const metricId = String(d.id || d.metric_id || defObj.id || defObj.metricId || "BOUNDARY_INTRUSION_SHARE").trim();
      const metricName = String(d.name || defObj.name || metricId || "Boundary Intrusion Share").trim();
      return {
        id: metricId || "BOUNDARY_INTRUSION_SHARE",
        version: Number(d.version || defObj.version || 1),
        name: metricName || "Boundary Intrusion Share",
        hazard_domain: String(d.hazard_domain || defObj.hazardDomain || defObj.hazard_domain || "Working Time Quality & Rest Deficits"),
        formula_id: String(d.formula_id || defObj.formulaId || defObj.formula_id || "boundaryIntrusionShare"),
        contributor_floor: Number(d.contributor_floor || defObj.contributorFloor || defObj.contributor_floor || 10),
        min_window_days: Number(d.min_window_days || defObj.minWindowDays || defObj.min_window_days || 28),
        created_at: String(d.approved_at || defObj.createdAt || new Date().toISOString())
      };
    }).filter(d => Boolean(d.id && d.name));
    res.status(200).json(defs);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Request cohort result for a semantic query (Compiler Gate: n>=10, window>=28d, overlap/residual differencing)
app.post("/api/v2/releases/query", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    // Extract query and optional custom cohort members (used by Reconstruction Lab)
    const rawQuery = (req.body && req.body.query) ? req.body.query : req.body;
    // Caller-supplied cohorts bypass the n>=10 privacy floor, so they are a Reconstruction Lab feature for local/test only
    const customCohortMembers = (cfg.appEnv === "local" || cfg.appEnv === "test")
      && req.body && Array.isArray(req.body.customCohortMembers)
      ? req.body.customCohortMembers
      : undefined;

    // Validate using strict SemanticQueryV1 schema
    const normDate = (d: any, fallback: string) => {
      const val = d || fallback;
      return typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val) ? `${val}T00:00:00.000Z` : val;
    };
    const query = SemanticQueryV1.parse({
      metricId: rawQuery.metricId || "BOUNDARY_INTRUSION_SHARE",
      metricVersion: Number(rawQuery.metricVersion) || 1,
      cohortRef: rawQuery.cohortRef || "org:00000000-0000-4000-a001-000000000001",
      periodStart: normDate(rawQuery.periodStart, "2026-03-02T00:00:00.000Z"),
      periodEnd: normDate(rawQuery.periodEnd, "2026-03-30T00:00:00.000Z"),
      releaseClass: rawQuery.releaseClass || "CLASS_B"
    });

    const out = await compileRelease(who.tenantId, query, customCohortMembers);

    // Playbook mandate: Identical body shape for every suppression reason (FLOOR, OVERLAP, RESIDUAL, QUALITY)
    if (out.status === "RELEASED" && out.releaseId) {
      recordPrivacyOutcome("RELEASED");
      const release = await getRelease(actor, out.releaseId);
      res.status(200).json(release);
    } else {
      recordPrivacyOutcome("SUPPRESSED");
      res.status(200).json({ status: "UNAVAILABLE", code: "NOT_AVAILABLE" });
    }
  } catch (err) {
    if (!(err instanceof AppError)) {
      recordPrivacyOutcome("ERROR");
    }
    toErrorResponse(err, res);
  }
});

// Fetch a released value (The single read path: employer channels read released_artifact only)
app.get("/api/v2/releases/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    // Phase 7: The API refuses to return a Plane-B release from an assurance endpoint
    const release = await getRelease(actor, String(req.params.id), "A");
    res.status(200).json(release);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// CSV Export of released value
app.get("/api/v2/releases/:id/export.csv", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    const release = await getRelease(actor, String(req.params.id));
    if (release.status !== "RELEASED") {
      throw new AppError("NOT_FOUND", "No approved release found to export.");
    }

    const headers = "Release ID,Metric,Version,Value,Unit,Period Start,Period End,Quality,Interpretation\n";
    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    const row = `${release.releaseId},${escapeCsv(release.metricName)},${release.version},${release.value},${release.unit},${release.periodStart},${release.periodEnd},${release.quality},${escapeCsv(release.interpretation || "")}\n`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="release-${release.releaseId.slice(0, 8)}.csv"`);
    res.status(200).send(headers + row);
  } catch (err) {
    toErrorResponse(err, res);
  }
});



// Trigger metric recomputation after correction (worker job)
app.post("/api/v2/metrics/:id/recalculate", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date(), who.role);

    const jobId = crypto.randomUUID();
    let recalculatedCount = 0;
    // In production, enqueued to worker; here marks the tenant's active releases of this metric SUPERSEDED
    // and persists the job row durably in async_job (0087_async_jobs_and_role_policies.sql).
    await withTenant(who.tenantId, async (tx) => {
      const releases = (await tx.q("SELECT * FROM privacy_release")).rows
        .filter((r: any) => r.metric_id === req.params.id && r.status === "RELEASED");
      for (const r of releases) {
        await tx.q("UPDATE privacy_release SET status = $1 WHERE id = $2", ["SUPERSEDED", r.id]);
        recalculatedCount++;
      }
      await tx.q(
        `INSERT INTO async_job (id, tenant_id, job_type, state, progress, result_summary, error_code)
         VALUES ($1, $2, $3, 'COMPLETED', 100, $4, NULL)`,
        [jobId, who.tenantId, "METRIC_RECALCULATION", JSON.stringify({ status: "SUCCESS", count: recalculatedCount })]
      );
    });

    res.status(202).json({
      jobId,
      status: "QUEUED",
      count: recalculatedCount,
      message: "Recalculation job queued; affected snapshots and releases marked superseded."
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});


registerControlRoutes(app);
registerLifecycleRoutes(app);
registerOpsRoutes(app);
registerAiActionRoutes(app);
registerPlanesRoutes(app);
// -------------------------------------------------------------
// Domain S13: Sector work-item endpoints (generic + legal aliases)
// -------------------------------------------------------------
registerSectorWorkRoutes(app, { getHeader });

// Final handler: body-parser and any unrouted error get the safe envelope, never Express's HTML/stack page
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return toErrorResponse(new AppError("VALIDATION", "The request body could not be parsed."), res);
  }
  return toErrorResponse(err, res);
});

// -------------------------------------------------------------
// Server Initialization
// -------------------------------------------------------------

// Only listen when run as the entrypoint, so tools can mount the app on an ephemeral port
const server = require.main === module
  ? app.listen(cfg.port, "0.0.0.0", () => {
    console.log(`\x1b[32m[Zoiko Abate Server] Running at http://localhost:${cfg.port}\x1b[0m`);
    console.log(`[Config] Environment: ${cfg.appEnv} | Client URL: ${cfg.clientUrl}`);
    console.log(`[Config] Fixed Clock: ${cfg.fixedClock}`);
  })
  : null;

export { app, server };
