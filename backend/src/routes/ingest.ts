// backend/src/routes/ingest.ts
import type { Express, Request, Response } from "express";
import { loadConfig } from "../platform/config";
import { toErrorResponse, AppError } from "../platform/errors";
import { ZoikoTimeBatchV1, CalendarCadenceBatchV1, CreateConnectionInput, SourceAdapterName } from "../contracts";
import { authenticate, resolveActor } from "../domains/tenant/auth";
import {
  ingestBatch,
  listSourceContracts,
  listConnections,
  getConnection,
  registerConnection,
  setConnectionState,
  listReceipts,
  listWorkFacts,
  type ConnectionState
} from "../domains/ingest";
import { verifyConnectorWebhookRequest } from "../domains/ingest/webhook-auth";
import { applyCursorPagination, setPaginationHeaders, validateAllowedQueryParams } from "../platform/pagination";
import { getHeader, parseLimit } from "./helpers";

export function registerIngestRoutes(app: Express): void {
  // -------------------------------------------------------------
  // Domain S02 / S03: Phase 2 Ingestion & Work-State Ledger Endpoints
  // -------------------------------------------------------------

  async function handleConnectorBatchRequest(
    req: Request,
    res: Response,
    schema: typeof ZoikoTimeBatchV1 | typeof CalendarCadenceBatchV1,
    connectorSource: SourceAdapterName
  ) {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const runtimeCfg = loadConfig();
      const sigHeader = getHeader(req, "x-abate-signature");
      const tsHeader = getHeader(req, "x-abate-timestamp");
      const nonceHeader = getHeader(req, "x-abate-nonce");
      if (runtimeCfg.connectorWebhookSecret || sigHeader || tsHeader) {
        verifyConnectorWebhookRequest({
          secret: runtimeCfg.connectorWebhookSecret,
          signatureHeader: sigHeader,
          timestampHeader: tsHeader,
          nonceHeader,
          body: req.body
        });
      }

      // Strict schema parse: unknown or prohibited top-level fields rejected immediately
      const batch = schema.parse(req.body);
      const idempotencyKey = getHeader(req, "idempotency-key") || batch.batchId;
      const out = await ingestBatch({
        who,
        actor,
        batch,
        idempotencyKey,
        connectorSource
      });

      res.status(out.status).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  }

  async function handleConnectionStateRequest(
    req: Request,
    res: Response,
    newState: ConnectionState | "RESUME_AUTO"
  ) {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const connectionId = String(req.params.id);

      const ifMatch = getHeader(req, "if-match");
      if (ifMatch) {
        const current = await getConnection({ who, actor, connectionId });
        const expectedEtag = String(current.state);
        const cleanMatch = ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
        if (cleanMatch !== expectedEtag) {
          throw new AppError("CONFLICT", `Stale connection state conflict: expected state "${expectedEtag}". Refresh and retry.`);
        }
      }

      const out = await setConnectionState({
        who,
        actor,
        connectionId,
        newState,
        idempotencyKey: getHeader(req, "idempotency-key") || undefined
      });
      if (out.body?.state) {
        res.setHeader("ETag", `"${out.body.state}"`);
      }
      res.status(out.status).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  }

  // Ingest ZoikoTime batch (Strict allowlist, natural batchId idempotency, returns safe counts)
  app.post("/api/v2/connectors/zoikotime/batches", (req: Request, res: Response) => {
    return handleConnectorBatchRequest(req, res, ZoikoTimeBatchV1, "ZoikoTime");
  });

  // Ingest CalendarCadence batch (Strict allowlist; rejects meeting subjects, attendees, descriptions)
  app.post("/api/v2/connectors/calendar-cadence/batches", (req: Request, res: Response) => {
    return handleConnectorBatchRequest(req, res, CalendarCadenceBatchV1, "CalendarCadence");
  });

  // List approved Source Contracts for tenant
  app.get("/api/v2/source-contracts", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const contracts = await listSourceContracts({ who, actor });
      res.status(200).json(contracts);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Register new idempotent Source Connection bound to an active contract
  app.post("/api/v2/connections", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);
      const idempotencyKey = getHeader(req, "idempotency-key");
      if (!idempotencyKey) {
        throw new AppError("VALIDATION", "Missing mandatory Idempotency-Key header.");
      }
      const input = CreateConnectionInput.parse(req.body);
      const out = await registerConnection({ who, actor, input, idempotencyKey });
      res.status(out.status).json(out.body);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // List Connections for tenant (includes freshness & health derivation)
  app.get("/api/v2/connections", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const conns = await listConnections({ who, actor });
      res.status(200).json(conns);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  app.get("/api/v2/connections/:id", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const conn = await getConnection({ who, actor, connectionId: String(req.params.id) });
      if (conn?.state) {
        res.setHeader("ETag", `"${conn.state}"`);
      }
      res.status(200).json(conn);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Connection state transitions:
  // Reversible: PAUSED, SUSPENDED, RESUMED / ACTIVE.
  // Terminal: DISCONNECTED (and legacy /revoke -> REVOKED).
  app.post("/api/v2/connections/:id/pause", (req: Request, res: Response) => {
    return handleConnectionStateRequest(req, res, "PAUSED");
  });

  app.post("/api/v2/connections/:id/suspend", (req: Request, res: Response) => {
    return handleConnectionStateRequest(req, res, "SUSPENDED");
  });

  app.post("/api/v2/connections/:id/resume", (req: Request, res: Response) => {
    return handleConnectionStateRequest(req, res, "RESUME_AUTO");
  });

  app.post("/api/v2/connections/:id/disconnect", (req: Request, res: Response) => {
    return handleConnectionStateRequest(req, res, "DISCONNECTED");
  });

  app.post("/api/v2/connections/:id/revoke", (req: Request, res: Response) => {
    return handleConnectionStateRequest(req, res, "REVOKED");
  });

  // Ingest Receipts (Traceable receipts with counts only, NEVER rejected payloads)
  app.get("/api/v2/receipts", async (req: Request, res: Response) => {
    try {
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const receipts = await listReceipts({ who, actor, limit: parseLimit(req, 200, 1000) });
      res.status(200).json(receipts);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // Work Fact Revisions (Pseudonymized ledger facts)
  app.get("/api/v2/work-facts", async (req: Request, res: Response) => {
    try {
      validateAllowedQueryParams(req, ["limit", "cursor", "kind", "connectionId"]);
      const who = await authenticate(getHeader(req, "authorization"));
      const actor = await resolveActor(who.tenantId, who.subject, new Date(), who.role);

      const limit = parseLimit(req, 200, 1000);
      const filterKind = typeof req.query.kind === "string" ? req.query.kind : undefined;
      const filterConnectionId = typeof req.query.connectionId === "string" ? req.query.connectionId : undefined;
      const facts = await listWorkFacts({ who, actor, limit: 1000 });
      const filtered = facts.filter((f: any) => {
        if (filterKind && f.kind !== filterKind) return false;
        if (filterConnectionId && f.connection_id !== filterConnectionId) return false;
        return true;
      });
      const page = applyCursorPagination(filtered, {
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit,
        getKey: (f: any) => String(f.id)
      });
      setPaginationHeaders(res, page);
      res.status(200).json(page.items);
    } catch (err) {
      toErrorResponse(err, res);
    }
  });

  // -------------------------------------------------------------
  // Domain S04 / S06: Phase 3 Measurement & Privacy Release Endpoints
}
