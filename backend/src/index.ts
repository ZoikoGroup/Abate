// backend/src/index.ts
import express, { Request, Response } from "express";
import cors from "cors";
import { loadConfig } from "./platform/config";
import { toErrorResponse, AppError } from "./platform/errors";
import { openApiSpec, CreateOrganizationBody, TokenRequestBody, ZoikoTimeBatchV1 } from "./contracts";
import { authenticate, resolveActor, createDevToken } from "./domains/tenant/auth";
import { createOrganization, getOrganization, listOrganizations, getTenant } from "./domains/tenant/commands";
import { ingestBatch, listConnections, getConnection, setConnectionState, listReceipts, listWorkFacts } from "./domains/ingest";
import { drainOnce } from "./worker/outbox-publisher";
import { memDb } from "./platform/db/with-tenant";
import { seedTwoTenants } from "./fixtures/seed";

const cfg = loadConfig();
const app = express();

app.use(cors({
  origin: cfg.clientUrl,
  credentials: true
}));

app.use(express.json());

// Initialize fixtures for development environment
if (cfg.appEnv === "local" || cfg.appEnv === "test") {
  seedTwoTenants({ clock: new Date(cfg.fixedClock) }).catch(err => {
    console.warn("[Init] Local fixture seeding notice:", err.message);
  });
}

function getHeader(req: Request, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (!val) return null;
  return Array.isArray(val) ? val[0] ?? null : val;
}

// -------------------------------------------------------------
// Health and Metadata Endpoints
// -------------------------------------------------------------

app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    app: "Zoiko Abate",
    version: "1.0.0",
    environment: cfg.appEnv,
    timestamp: new Date().toISOString(),
    constitutionalBoundaries: {
      individualScoring: "PROHIBITED",
      surveillanceMining: "PROHIBITED",
      clinicalDependency: "PROHIBITED",
      privacyGate: "CLASS_B_C_MIN_10_CONTRIBUTORS",
      planeSeparation: "PLANE_B_CANNOT_MUTATE_PLANE_A"
    }
  });
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
      S11_S12: "Commercial / lifecycle"
    }
  });
});

// Canonical Contract Registry (OpenAPI 3.1)
app.get("/api/v2/contracts/openapi.json", (_req: Request, res: Response) => {
  res.status(200).json(openApiSpec);
});

// -------------------------------------------------------------
// Authentication Endpoints (/api/v2/auth)
// -------------------------------------------------------------

app.post("/api/v2/auth/token", (req: Request, res: Response) => {
  try {
    const body = TokenRequestBody.parse(req.body);
    const token = createDevToken(body);
    res.status(200).json({
      token,
      tokenType: "Bearer",
      expiresIn: "8h",
      tenantId: body.tenantId,
      subject: body.subject,
      role: body.role
    });
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Domain S01: Tenancy and Organization Endpoints (/api/v2)
// -------------------------------------------------------------

app.get("/api/v2/tenants/current", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
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
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    
    // Strict schema validation: rejects unknown or prohibited fields immediately
    const body = CreateOrganizationBody.parse(req.body);

    const idempotencyKey = getHeader(req, "idempotency-key") || getHeader(req, "x-idempotency-key");
    if (!idempotencyKey) {
      throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
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
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const orgs = await listOrganizations({ who, actor });
    res.status(200).json(orgs);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/organizations/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
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
    const who = await authenticate(getHeader(req, "authorization"));
    await resolveActor(who.tenantId, who.subject, new Date());

    // Filter audit trail strictly by authenticated tenant
    const events = memDb.auditEvents.filter(e => e.tenant_id === who.tenantId);
    res.status(200).json(events);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Worker Outbox Drainage Endpoint
app.post("/api/v2/outbox/drain", async (_req: Request, res: Response) => {
  try {
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

// -------------------------------------------------------------
// Domain S02 / S03: Phase 2 Ingestion & Work-State Ledger Endpoints
// -------------------------------------------------------------

// Ingest ZoikoTime batch (Strict allowlist, natural batchId idempotency, returns safe counts)
app.post("/api/v2/connectors/zoikotime/batches", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());
    
    // Strict schema parse: unknown or prohibited top-level fields rejected immediately
    const batch = ZoikoTimeBatchV1.parse(req.body);

    const idempotencyKey = getHeader(req, "idempotency-key") || batch.batchId;
    const out = await ingestBatch({
      who,
      actor,
      batch,
      idempotencyKey
    });

    res.status(out.status).json(out.body);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// List Connections for tenant (includes freshness & health derivation)
app.get("/api/v2/connections", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conns = await listConnections({ who, actor });
    res.status(200).json(conns);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.get("/api/v2/connections/:id", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await getConnection({ who, actor, connectionId: String(req.params.id) });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Connection state transitions (Pause / Resume / Revoke)
app.post("/api/v2/connections/:id/pause", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await setConnectionState({
      who,
      actor,
      connectionId: String(req.params.id),
      newState: "PAUSED"
    });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/connections/:id/resume", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await setConnectionState({
      who,
      actor,
      connectionId: String(req.params.id),
      newState: "ACTIVE"
    });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

app.post("/api/v2/connections/:id/revoke", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const conn = await setConnectionState({
      who,
      actor,
      connectionId: String(req.params.id),
      newState: "REVOKED"
    });
    res.status(200).json(conn);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Ingest Receipts (Traceable receipts with counts only, NEVER rejected payloads)
app.get("/api/v2/receipts", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const receipts = await listReceipts({ who, actor });
    res.status(200).json(receipts);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// Work Fact Revisions (Pseudonymized ledger facts)
app.get("/api/v2/work-facts", async (req: Request, res: Response) => {
  try {
    const who = await authenticate(getHeader(req, "authorization"));
    const actor = await resolveActor(who.tenantId, who.subject, new Date());

    const facts = await listWorkFacts({ who, actor });
    res.status(200).json(facts);
  } catch (err) {
    toErrorResponse(err, res);
  }
});

// -------------------------------------------------------------
// Server Initialization
// -------------------------------------------------------------

const server = app.listen(cfg.port, "0.0.0.0", () => {
  console.log(`\x1b[32m[Zoiko Abate Server] Running at http://localhost:${cfg.port}\x1b[0m`);
  console.log(`[Config] Environment: ${cfg.appEnv} | Client URL: ${cfg.clientUrl}`);
  console.log(`[Config] Fixed Clock: ${cfg.fixedClock}`);
});

export { app, server };
