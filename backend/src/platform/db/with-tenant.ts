// backend/src/platform/db/with-tenant.ts
import { Pool, PoolClient, QueryResult } from "pg";
import { loadConfig } from "../config";
import { AppError } from "../errors";

const cfg = loadConfig();

export type QueryFn = (text: string, params?: any[]) => Promise<QueryResult<any>>;
export type Tx = { q: QueryFn; tenantId: string };

// Production PostgreSQL Pools
export let appPool: Pool | null = null;
export let migratorPool: Pool | null = null;

try {
  appPool = new Pool({
    connectionString: cfg.databaseUrlApp,
    max: 20,
    connectionTimeoutMillis: 1000
  });
  // Prevent unhandled errors on idle clients
  appPool.on("error", () => {});

  migratorPool = new Pool({
    connectionString: cfg.databaseUrlMigrator,
    max: 5,
    connectionTimeoutMillis: 1000
  });
  migratorPool.on("error", () => {});
} catch {
  // Graceful fallback to embedded store if Postgres is not available
}

// In-Memory Database Store for environments without a live PostgreSQL instance
class MemoryDatabase {
  public tenants: Map<string, any> = new Map();
  public principals: Map<string, any> = new Map();
  public organizations: Map<string, any> = new Map();
  public memberships: Map<string, any> = new Map();
  public idempotency: Map<string, any> = new Map();
  public auditEvents: any[] = [];
  public outboxEvents: any[] = [];
  public inboxEvents: Map<string, any> = new Map();
  
  // Phase 2 Ingestion & Work-State Ledger
  public sourceContracts: Map<string, any> = new Map();
  public connections: Map<string, any> = new Map();
  public watermarks: Map<string, any> = new Map();
  public ingestReceipts: Map<string, any> = new Map();
  public workFactRevisions: Map<string, any> = new Map();

  clear() {
    this.tenants.clear();
    this.principals.clear();
    this.organizations.clear();
    this.memberships.clear();
    this.idempotency.clear();
    this.auditEvents = [];
    this.outboxEvents = [];
    this.inboxEvents.clear();
    this.sourceContracts.clear();
    this.connections.clear();
    this.watermarks.clear();
    this.ingestReceipts.clear();
    this.workFactRevisions.clear();
  }
}

export const memDb = new MemoryDatabase();

// In-Memory Transaction Client simulating Postgres RLS and transaction-local set_config
class MemoryClient {
  private inTransaction = false;
  private tenantContext: string | null = null;
  private snapshotState: string | null = null;

  async query(text: string, params: any[] = []): Promise<QueryResult<any>> {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();

    if (upper === "BEGIN") {
      this.inTransaction = true;
      this.snapshotState = JSON.stringify({
        tenants: Array.from(memDb.tenants.entries()),
        principals: Array.from(memDb.principals.entries()),
        organizations: Array.from(memDb.organizations.entries()),
        memberships: Array.from(memDb.memberships.entries()),
        idempotency: Array.from(memDb.idempotency.entries()),
        auditCount: memDb.auditEvents.length,
        outboxCount: memDb.outboxEvents.length,
        inbox: Array.from(memDb.inboxEvents.entries()),
        sourceContracts: Array.from(memDb.sourceContracts.entries()),
        connections: Array.from(memDb.connections.entries()),
        watermarks: Array.from(memDb.watermarks.entries()),
        ingestReceipts: Array.from(memDb.ingestReceipts.entries()),
        workFactRevisions: Array.from(memDb.workFactRevisions.entries())
      });
      return { rows: [], rowCount: 0, command: "BEGIN", oid: 0, fields: [] };
    }

    if (upper === "COMMIT") {
      this.inTransaction = false;
      this.tenantContext = null;
      this.snapshotState = null;
      return { rows: [], rowCount: 0, command: "COMMIT", oid: 0, fields: [] };
    }

    if (upper === "ROLLBACK") {
      if (this.snapshotState) {
        const snap = JSON.parse(this.snapshotState);
        memDb.tenants = new Map(snap.tenants);
        memDb.principals = new Map(snap.principals);
        memDb.organizations = new Map(snap.organizations);
        memDb.memberships = new Map(snap.memberships);
        memDb.idempotency = new Map(snap.idempotency);
        memDb.auditEvents = memDb.auditEvents.slice(0, snap.auditCount);
        memDb.outboxEvents = memDb.outboxEvents.slice(0, snap.outboxCount);
        memDb.inboxEvents = new Map(snap.inbox);
        if (snap.sourceContracts) memDb.sourceContracts = new Map(snap.sourceContracts);
        if (snap.connections) memDb.connections = new Map(snap.connections);
        if (snap.watermarks) memDb.watermarks = new Map(snap.watermarks);
        if (snap.ingestReceipts) memDb.ingestReceipts = new Map(snap.ingestReceipts);
        if (snap.workFactRevisions) memDb.workFactRevisions = new Map(snap.workFactRevisions);
      }
      this.inTransaction = false;
      this.tenantContext = null;
      this.snapshotState = null;
      return { rows: [], rowCount: 0, command: "ROLLBACK", oid: 0, fields: [] };
    }

    // SELECT set_config('app.tenant_id', $1, true)
    if (upper.includes("SET_CONFIG('APP.TENANT_ID'")) {
      this.tenantContext = params[0] || null;
      return { rows: [{ set_config: this.tenantContext }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    }

    // Fail-Closed RLS Enforcement: If querying tenant-isolated tables without tenant context, return 0 rows
    const isTenantTable = /FROM\s+(principal|organization|effective_membership|idempotency_record|audit_event|outbox_event|source_contract|connection|watermark|ingest_receipt|work_fact_revision)/i.test(trimmed);
    if (isTenantTable && !this.tenantContext) {
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    }

    // Idempotency insert
    if (upper.includes("INSERT INTO IDEMPOTENCY_RECORD")) {
      const [tId, op, key, hash, status] = params;
      const primaryKey = `${tId}:${op}:${key}`;
      if (memDb.idempotency.has(primaryKey)) {
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      }
      const record = {
        tenant_id: tId,
        operation: op,
        idempotency_key: key,
        request_hash: hash,
        status: status || "IN_PROGRESS",
        response_status: null,
        response_body: null,
        created_at: new Date().toISOString()
      };
      memDb.idempotency.set(primaryKey, record);
      return { rows: [record], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Idempotency select for update
    if (upper.includes("FROM IDEMPOTENCY_RECORD") && upper.includes("FOR UPDATE")) {
      const [tId, op, key] = params;
      const primaryKey = `${tId}:${op}:${key}`;
      const rec = memDb.idempotency.get(primaryKey);
      if (!rec || rec.tenant_id !== this.tenantContext) {
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      }
      return { rows: [rec], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    }

    // Idempotency update
    if (upper.includes("UPDATE IDEMPOTENCY_RECORD")) {
      const [tId, op, key, body] = params;
      const primaryKey = `${tId}:${op}:${key}`;
      const rec = memDb.idempotency.get(primaryKey);
      if (rec && rec.tenant_id === this.tenantContext) {
        rec.status = "DONE";
        rec.response_status = 200;
        rec.response_body = typeof body === "string" ? JSON.parse(body) : body;
        return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Audit Event Insert (Append-only)
    if (upper.includes("INSERT INTO AUDIT_EVENT")) {
      const [tId, actorId, purpose, cmd, resType, resId, resVer, res, evidence] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant write rejected");
      }
      const event = {
        id: memDb.auditEvents.length + 1,
        tenant_id: tId,
        actor_id: actorId,
        purpose,
        command: cmd,
        resource_type: resType,
        resource_id: resId,
        resource_version: resVer,
        result: res,
        evidence_refs: evidence || [],
        occurred_at: new Date().toISOString()
      };
      memDb.auditEvents.push(event);
      return { rows: [event], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Outbox Event Insert
    if (upper.includes("INSERT INTO OUTBOX_EVENT")) {
      const [id, tId, agg, aggId, aggVer, evtType, schemaVer, purpose, refs] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant write rejected");
      }
      const event = {
        id,
        tenant_id: tId,
        aggregate: agg,
        aggregate_id: aggId,
        aggregate_version: aggVer,
        event_type: evtType,
        schema_version: schemaVer,
        purpose,
        refs: refs || [],
        created_at: new Date().toISOString(),
        published_at: null
      };
      memDb.outboxEvents.push(event);
      return { rows: [event], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Organization Insert
    if (upper.includes("INSERT INTO ORGANIZATION")) {
      const [id, tId, parentId, name] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant organization write rejected");
      }
      const org = { id, tenant_id: tId, parent_id: parentId || null, name };
      memDb.organizations.set(id, org);
      return { rows: [org], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Organization Select
    if (upper.includes("FROM ORGANIZATION")) {
      let rows = Array.from(memDb.organizations.values());
      // RLS filter
      rows = rows.filter(o => o.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(o => o.id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Principal + Membership resolution (authenticate & resolveActor)
    if (upper.includes("FROM PRINCIPAL") && upper.includes("EFFECTIVE_MEMBERSHIP")) {
      const [subject, atStr] = params;
      const at = new Date(atStr).getTime();
      const results: any[] = [];

      for (const p of memDb.principals.values()) {
        if (p.tenant_id !== this.tenantContext || p.external_subject !== subject) continue;
        for (const m of memDb.memberships.values()) {
          if (m.principal_id === p.id && m.tenant_id === this.tenantContext) {
            const vFrom = new Date(m.valid_from).getTime();
            const vTo = m.valid_to ? new Date(m.valid_to).getTime() : Infinity;
            if (vFrom <= at && at < vTo) {
              results.push({
                id: p.id,
                organization_id: m.organization_id,
                domain_role: m.domain_role
              });
            }
          }
        }
      }
      return { rows: results, rowCount: results.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Principal select
    if (upper.includes("FROM PRINCIPAL")) {
      let rows = Array.from(memDb.principals.values()).filter(p => p.tenant_id === this.tenantContext);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Tenant select
    if (upper.includes("FROM TENANT")) {
      let rows = Array.from(memDb.tenants.values());
      if (this.tenantContext) {
        rows = rows.filter(t => t.id === this.tenantContext);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Outbox Drain: SELECT * FROM outbox_event WHERE published_at IS NULL
    if (upper.includes("FROM OUTBOX_EVENT WHERE PUBLISHED_AT IS NULL")) {
      const unpublished = memDb.outboxEvents.filter(e => !e.published_at);
      return { rows: unpublished, rowCount: unpublished.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Outbox mark published: UPDATE outbox_event SET published_at = now()
    if (upper.includes("UPDATE OUTBOX_EVENT SET PUBLISHED_AT")) {
      const id = params[0];
      const ev = memDb.outboxEvents.find(e => e.id === id);
      if (ev) ev.published_at = new Date().toISOString();
      return { rows: ev ? [ev] : [], rowCount: ev ? 1 : 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Inbox Event Insert: INSERT INTO inbox_event (consumer, event_id, tenant_id) ... ON CONFLICT DO NOTHING
    if (upper.includes("INSERT INTO INBOX_EVENT")) {
      const [consumer, eventId, tenantId] = params;
      const key = `${consumer}:${eventId}`;
      if (memDb.inboxEvents.has(key)) {
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      }
      const entry = { consumer, event_id: eventId, tenant_id: tenantId, received_at: new Date().toISOString() };
      memDb.inboxEvents.set(key, entry);
      return { rows: [entry], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // -------------------------------------------------------------
    // Phase 2 Ingestion & Ledger Handlers
    // -------------------------------------------------------------

    // Connection Select
    if (upper.includes("FROM CONNECTION")) {
      let rows = Array.from(memDb.connections.values()).filter(c => c.tenant_id === this.tenantContext);
      if (params.length > 0) {
        // e.g. WHERE id = $1
        rows = rows.filter(c => c.id === params[0] || (params.length > 1 && c.id === params[1]));
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Connection Update (state / last_success_at)
    if (upper.includes("UPDATE CONNECTION")) {
      if (upper.includes("SET STATE = $1") || upper.includes("SET STATE=$1")) {
        const [newState, connId] = params;
        const conn = memDb.connections.get(connId);
        if (conn && conn.tenant_id === this.tenantContext) {
          conn.state = newState;
          return { rows: [conn], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
        }
      }
      if (upper.includes("LAST_SUCCESS_AT")) {
        const connId = params[0];
        const conn = memDb.connections.get(connId);
        if (conn && conn.tenant_id === this.tenantContext) {
          conn.last_success_at = new Date().toISOString();
          return { rows: [conn], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
        }
      }
      return { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Work Fact Revision Insert (with ON CONFLICT DO NOTHING RETURNING 1)
    if (upper.includes("INSERT INTO WORK_FACT_REVISION")) {
      const [id, tId, connId, recordId, revision, pseudonym, startAt, endAt, workTz, kind, payloadHash, receiptId] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant work_fact write rejected");
      }
      const dedupeKey = `${tId}:${connId}:${recordId}:${revision}`;
      if (memDb.workFactRevisions.has(dedupeKey)) {
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      }
      const record = {
        id,
        tenant_id: tId,
        connection_id: connId,
        source_record_id: recordId,
        revision,
        subject_pseudonym: pseudonym,
        start_at: startAt,
        end_at: endAt,
        work_tz: workTz,
        kind,
        payload_hash: payloadHash,
        receipt_id: receiptId,
        recorded_at: new Date().toISOString()
      };
      memDb.workFactRevisions.set(dedupeKey, record);
      return { rows: [record], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Work Fact Revision Select Previous Hash for Duplicate/Conflict classification
    if (upper.includes("SELECT PAYLOAD_HASH FROM WORK_FACT_REVISION")) {
      const [tId, connId, recordId, revision] = params;
      const dedupeKey = `${tId}:${connId}:${recordId}:${revision}`;
      const existing = memDb.workFactRevisions.get(dedupeKey);
      if (!existing || existing.tenant_id !== this.tenantContext) {
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      }
      return { rows: [{ payload_hash: existing.payload_hash }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    }

    // Work Fact Revision Select All
    if (upper.includes("FROM WORK_FACT_REVISION")) {
      let rows = Array.from(memDb.workFactRevisions.values()).filter(r => r.tenant_id === this.tenantContext);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Ingest Receipt Insert
    if (upper.includes("INSERT INTO INGEST_RECEIPT")) {
      const [id, tId, connId, batchId, accepted, duplicate, rejected, conflicted] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant receipt write rejected");
      }
      const receipt = {
        id,
        tenant_id: tId,
        connection_id: connId,
        batch_id: batchId,
        accepted,
        duplicate,
        rejected,
        conflicted,
        received_at: new Date().toISOString()
      };
      memDb.ingestReceipts.set(id, receipt);
      return { rows: [receipt], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Ingest Receipt Select
    if (upper.includes("FROM INGEST_RECEIPT")) {
      let rows = Array.from(memDb.ingestReceipts.values()).filter(r => r.tenant_id === this.tenantContext);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Watermark Update/Insert
    if (upper.includes("WATERMARK")) {
      return { rows: [], rowCount: 1, command: "UPSERT", oid: 0, fields: [] };
    }

    return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
  }

  release() {
    this.tenantContext = null;
  }
}

let isPgHealthy: boolean | null = null;

async function checkPgHealth(): Promise<boolean> {
  if (isPgHealthy !== null) return isPgHealthy;
  if (!appPool) {
    isPgHealthy = false;
    return false;
  }
  try {
    const client = await appPool.connect();
    await client.query("SELECT 1");
    client.release();
    isPgHealthy = true;
  } catch {
    isPgHealthy = false;
  }
  return isPgHealthy;
}

/**
 * withTenant: Transaction-local tenant context helper.
 * Enforces fail-closed isolation and prevents pooled connection leakage.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    throw new AppError("VALIDATION", "Invalid tenant ID format");
  }

  const usePg = await checkPgHealth();

  if (usePg && appPool) {
    const client: PoolClient = await appPool.connect();
    try {
      await client.query("BEGIN");
      // Set transaction-local setting; third parameter 'true' means local to this transaction only
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const out = await fn({ q: client.query.bind(client) as QueryFn, tenantId });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // Memory store fallback with identical RLS and transaction behavior
  const memClient = new MemoryClient();
  try {
    await memClient.query("BEGIN");
    await memClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn({ q: memClient.query.bind(memClient), tenantId });
    await memClient.query("COMMIT");
    return out;
  } catch (e) {
    await memClient.query("ROLLBACK");
    throw e;
  } finally {
    memClient.release();
  }
}

/**
 * withTenantOn: Helper used by boundary tests to verify pooled connection isolation.
 */
export async function withTenantOn<T>(
  pool: Pool | { query: QueryFn; connect: () => Promise<any> },
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return withTenant(tenantId, fn);
}
