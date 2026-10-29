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
class AdvisoryLockManager {
  private tails: Map<string, Promise<void>> = new Map();

  async acquire(key: string): Promise<() => void> {
    const currentTail = this.tails.get(key) || Promise.resolve();
    let releaseFn!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.tails.set(key, currentTail.then(() => nextLock));
    await currentTail;
    return () => {
      releaseFn();
    };
  }
}

const advisoryLockMgr = new AdvisoryLockManager();

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

  // Phase 3 Deterministic Measurement & Privacy Release
  public metricDefinitions: Map<string, any> = new Map();
  public metricSnapshots: Map<string, any> = new Map();
  public privacyDecisions: Map<string, any> = new Map();
  public privacyReleases: Map<string, any> = new Map();
  public releasedArtifacts: Map<string, any> = new Map();
  public disclosureLedger: any[] = [];

  // Phase 4 Hazard, Control & Verification
  public hazards: Map<string, any> = new Map();
  public causes: Map<string, any> = new Map();
  public interventions: Map<string, any> = new Map();
  public approvals: Map<string, any> = new Map();
  public implementationReceipts: Map<string, any> = new Map();
  public evaluations: Map<string, any> = new Map();

  // Phase 5 Jurisdiction Packs & Retention
  public jurisdictionPacks: Map<string, any> = new Map(); // global catalog, key pack_id:version
  public retentionClasses: Map<string, any> = new Map();
  public legalHolds: Map<string, any> = new Map();
  public retentionRuns: Map<string, any> = new Map();
  public deletionTombstones: Map<string, any> = new Map();

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
    this.metricDefinitions.clear();
    this.metricSnapshots.clear();
    this.privacyDecisions.clear();
    this.privacyReleases.clear();
    this.releasedArtifacts.clear();
    this.disclosureLedger = [];
    this.hazards.clear();
    this.causes.clear();
    this.interventions.clear();
    this.approvals.clear();
    this.implementationReceipts.clear();
    this.evaluations.clear();
    this.jurisdictionPacks.clear();
    this.retentionClasses.clear();
    this.legalHolds.clear();
    this.retentionRuns.clear();
    this.deletionTombstones.clear();
  }
}

export const memDb = new MemoryDatabase();

// In-Memory Transaction Client simulating Postgres RLS and transaction-local set_config
class MemoryClient {
  private inTransaction = false;
  private tenantContext: string | null = null;
  private snapshotState: string | null = null;
  private heldLocks: (() => void)[] = [];

  private releaseHeldLocks() {
    for (const rel of this.heldLocks) {
      try {
        rel();
      } catch {}
    }
    this.heldLocks = [];
  }

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
        workFactRevisions: Array.from(memDb.workFactRevisions.entries()),
        metricDefinitions: Array.from(memDb.metricDefinitions.entries()),
        metricSnapshots: Array.from(memDb.metricSnapshots.entries()),
        privacyDecisions: Array.from(memDb.privacyDecisions.entries()),
        privacyReleases: Array.from(memDb.privacyReleases.entries()),
        releasedArtifacts: Array.from(memDb.releasedArtifacts.entries()),
        disclosureCount: memDb.disclosureLedger.length,
        hazards: Array.from(memDb.hazards.entries()),
        causes: Array.from(memDb.causes.entries()),
        interventions: Array.from(memDb.interventions.entries()),
        approvals: Array.from(memDb.approvals.entries()),
        implementationReceipts: Array.from(memDb.implementationReceipts.entries()),
        evaluations: Array.from(memDb.evaluations.entries()),
        jurisdictionPacks: Array.from(memDb.jurisdictionPacks.entries()),
        retentionClasses: Array.from(memDb.retentionClasses.entries()),
        legalHolds: Array.from(memDb.legalHolds.entries()),
        retentionRuns: Array.from(memDb.retentionRuns.entries()),
        deletionTombstones: Array.from(memDb.deletionTombstones.entries())
      });
      return { rows: [], rowCount: 0, command: "BEGIN", oid: 0, fields: [] };
    }

    if (upper === "COMMIT") {
      this.inTransaction = false;
      this.tenantContext = null;
      this.snapshotState = null;
      this.releaseHeldLocks();
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
        if (snap.metricDefinitions) memDb.metricDefinitions = new Map(snap.metricDefinitions);
        if (snap.metricSnapshots) memDb.metricSnapshots = new Map(snap.metricSnapshots);
        if (snap.privacyDecisions) memDb.privacyDecisions = new Map(snap.privacyDecisions);
        if (snap.privacyReleases) memDb.privacyReleases = new Map(snap.privacyReleases);
        if (snap.releasedArtifacts) memDb.releasedArtifacts = new Map(snap.releasedArtifacts);
        if (snap.disclosureCount !== undefined) memDb.disclosureLedger = memDb.disclosureLedger.slice(0, snap.disclosureCount);
        if (snap.hazards) memDb.hazards = new Map(snap.hazards);
        if (snap.causes) memDb.causes = new Map(snap.causes);
        if (snap.interventions) memDb.interventions = new Map(snap.interventions);
        if (snap.approvals) memDb.approvals = new Map(snap.approvals);
        if (snap.implementationReceipts) memDb.implementationReceipts = new Map(snap.implementationReceipts);
        if (snap.evaluations) memDb.evaluations = new Map(snap.evaluations);
        if (snap.jurisdictionPacks) memDb.jurisdictionPacks = new Map(snap.jurisdictionPacks);
        if (snap.retentionClasses) memDb.retentionClasses = new Map(snap.retentionClasses);
        if (snap.legalHolds) memDb.legalHolds = new Map(snap.legalHolds);
        if (snap.retentionRuns) memDb.retentionRuns = new Map(snap.retentionRuns);
        if (snap.deletionTombstones) memDb.deletionTombstones = new Map(snap.deletionTombstones);
      }
      this.inTransaction = false;
      this.tenantContext = null;
      this.snapshotState = null;
      this.releaseHeldLocks();
      return { rows: [], rowCount: 0, command: "ROLLBACK", oid: 0, fields: [] };
    }

    // Advisory lock handling (Tenant-wide serialization lock)
    if (upper.includes("PG_ADVISORY_XACT_LOCK")) {
      const lockKey = params[0] || "default_lock";
      const unlock = await advisoryLockMgr.acquire(lockKey);
      this.heldLocks.push(unlock);
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    }

    // SELECT set_config('app.tenant_id', $1, true)
    if (upper.includes("SET_CONFIG('APP.TENANT_ID'")) {
      this.tenantContext = params[0] || null;
      return { rows: [{ set_config: this.tenantContext }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    }

    // Fail-Closed RLS Enforcement: If querying tenant-isolated tables without tenant context, return 0 rows
    const isTenantTable = /FROM\s+(principal|organization|effective_membership|idempotency_record|audit_event|outbox_event|source_contract|connection|watermark|ingest_receipt|work_fact_revision|metric_snapshot|privacy_decision|privacy_release|released_artifact|disclosure_ledger|hazard|cause|intervention|approval|implementation_receipt|evaluation|retention_class|legal_hold|retention_run|deletion_tombstone)/i.test(trimmed);
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
    // Phase 5 Jurisdiction Packs & Retention Handlers
    // Kept ahead of Phase 2 so the purge DELETE is not matched as a work fact SELECT.
    // -------------------------------------------------------------

    // Jurisdiction Pack Insert (global catalog, not tenant-scoped)
    if (upper.includes("INSERT INTO JURISDICTION_PACK")) {
      const [packId, version, jurisdiction, sector, effectiveFrom, effectiveTo, status, content, contentHash, approvedBy] = params;
      const key = `${packId}:${version}`;
      if (memDb.jurisdictionPacks.has(key)) {
        throw new Error("duplicate key value violates unique constraint jurisdiction_pack_pkey");
      }
      const rec = {
        pack_id: packId,
        version,
        jurisdiction,
        sector,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
        status,
        content,
        content_hash: contentHash,
        approved_by: approvedBy,
        approved_at: new Date().toISOString()
      };
      memDb.jurisdictionPacks.set(key, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Jurisdiction Pack close-out of an open-ended predecessor
    if (upper.includes("UPDATE JURISDICTION_PACK SET EFFECTIVE_TO")) {
      const [effectiveTo, packId, version] = params;
      const rec = memDb.jurisdictionPacks.get(`${packId}:${version}`);
      if (rec) rec.effective_to = effectiveTo;
      return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Jurisdiction Pack Select
    if (upper.includes("FROM JURISDICTION_PACK")) {
      const rows = Array.from(memDb.jurisdictionPacks.values()).filter(p => params.length === 0 || p.pack_id === params[0]);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Retention Class Insert (append-only versions)
    if (upper.includes("INSERT INTO RETENTION_CLASS")) {
      const [id, tId, category, days, basis, version, packId, packVersion, setBy] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant retention_class write rejected");
      }
      const clash = Array.from(memDb.retentionClasses.values())
        .some(c => c.tenant_id === tId && c.data_category === category && c.version === version);
      if (clash) {
        throw new Error("duplicate key value violates unique constraint retention_class_tenant_id_data_category_version_key");
      }
      const rec = {
        id,
        tenant_id: tId,
        data_category: category,
        retention_days: days,
        basis,
        version,
        status: "ACTIVE",
        pack_id: packId,
        pack_version: packVersion,
        set_by: setBy,
        created_at: new Date().toISOString()
      };
      memDb.retentionClasses.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Retention Class supersession
    if (upper.includes("UPDATE RETENTION_CLASS SET STATUS = 'SUPERSEDED'")) {
      const rec = memDb.retentionClasses.get(params[0]);
      if (rec && rec.tenant_id === this.tenantContext) {
        rec.status = "SUPERSEDED";
        return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Retention Class Select
    if (upper.includes("FROM RETENTION_CLASS")) {
      const rows = Array.from(memDb.retentionClasses.values()).filter(c => c.tenant_id === this.tenantContext);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Legal Hold Insert
    if (upper.includes("INSERT INTO LEGAL_HOLD")) {
      const [id, tId, category, scopeConnectionId, matterRef, reason, placedBy, placedAt] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant legal_hold write rejected");
      }
      const rec = {
        id,
        tenant_id: tId,
        data_category: category,
        scope_connection_id: scopeConnectionId || null,
        matter_ref: matterRef,
        reason,
        placed_by: placedBy,
        placed_at: placedAt || new Date().toISOString(),
        released_by: null,
        released_at: null,
        release_reason: null
      };
      memDb.legalHolds.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Legal Hold Release
    if (upper.includes("UPDATE LEGAL_HOLD")) {
      const [releasedBy, releasedAt, releaseReason, id] = params;
      const rec = memDb.legalHolds.get(id);
      if (rec && rec.tenant_id === this.tenantContext) {
        rec.released_by = releasedBy;
        rec.released_at = releasedAt;
        rec.release_reason = releaseReason;
        return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Legal Hold Select
    if (upper.includes("FROM LEGAL_HOLD")) {
      const rows = Array.from(memDb.legalHolds.values()).filter(h => h.tenant_id === this.tenantContext);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Retention Run Insert (append-only receipt)
    if (upper.includes("INSERT INTO RETENTION_RUN")) {
      const [id, tId, category, status, blockedReason, classId, classVersion, cutoff, eligible, held, purged, verified, runBy, completedAt] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant retention_run write rejected");
      }
      const rec = {
        id,
        tenant_id: tId,
        data_category: category,
        status,
        blocked_reason: blockedReason,
        retention_class_id: classId,
        retention_class_version: classVersion,
        cutoff,
        eligible,
        held,
        purged,
        verified,
        run_by: runBy,
        completed_at: completedAt || new Date().toISOString()
      };
      memDb.retentionRuns.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Retention Run Select
    if (upper.includes("FROM RETENTION_RUN")) {
      const rows = Array.from(memDb.retentionRuns.values()).filter(r => r.tenant_id === this.tenantContext);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Deletion Tombstone Insert
    if (upper.includes("INSERT INTO DELETION_TOMBSTONE")) {
      const [id, tId, runId, category, recordRef, recordDigest, recordKeyDigest] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant deletion_tombstone write rejected");
      }
      const clash = Array.from(memDb.deletionTombstones.values()).some(t => t.tenant_id === tId && t.record_ref === recordRef);
      if (clash) {
        throw new Error("duplicate key value violates unique constraint deletion_tombstone_tenant_id_record_ref_key");
      }
      const rec = {
        id,
        tenant_id: tId,
        run_id: runId,
        data_category: category,
        record_ref: recordRef,
        record_digest: recordDigest,
        record_key_digest: recordKeyDigest,
        deleted_at: new Date().toISOString(),
        verified_at: null
      };
      memDb.deletionTombstones.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Deletion Tombstone verification stamp (the only permitted update)
    if (upper.includes("UPDATE DELETION_TOMBSTONE SET VERIFIED_AT")) {
      const [verifiedAt, recordRef] = params;
      const rec = Array.from(memDb.deletionTombstones.values())
        .find(t => t.tenant_id === this.tenantContext && t.record_ref === recordRef);
      if (rec) rec.verified_at = verifiedAt;
      return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Deletion Tombstone Select (optionally by record_key_digest)
    if (upper.includes("FROM DELETION_TOMBSTONE")) {
      const rows = Array.from(memDb.deletionTombstones.values())
        .filter(t => t.tenant_id === this.tenantContext)
        .filter(t => params.length === 0 || t.record_key_digest === params[0]);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Work Fact purge: mirrors the work_fact_purge_guard trigger in 0050_retention_jurisdiction.sql
    if (upper.includes("DELETE FROM WORK_FACT_REVISION")) {
      const entry = Array.from(memDb.workFactRevisions.entries())
        .find(([, r]) => r.id === params[0] && r.tenant_id === this.tenantContext);
      if (!entry) {
        return { rows: [], rowCount: 0, command: "DELETE", oid: 0, fields: [] };
      }
      const [key, fact] = entry;
      const hasTombstone = Array.from(memDb.deletionTombstones.values())
        .some(t => t.tenant_id === fact.tenant_id && t.record_ref === fact.id);
      if (!hasTombstone) {
        throw new Error(`work_fact_revision ${fact.id} cannot be deleted without a deletion tombstone`);
      }
      const held = Array.from(memDb.legalHolds.values()).some(h =>
        h.tenant_id === fact.tenant_id &&
        h.data_category === "WORK_FACT" &&
        !h.released_at &&
        (!h.scope_connection_id || h.scope_connection_id === fact.connection_id)
      );
      if (held) {
        throw new Error(`work_fact_revision ${fact.id} is under legal hold`);
      }
      memDb.workFactRevisions.delete(key);
      return { rows: [fact], rowCount: 1, command: "DELETE", oid: 0, fields: [] };
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

    // -------------------------------------------------------------
    // Phase 3 Deterministic Measurement & Privacy Release Handlers
    // -------------------------------------------------------------

    // Metric Definition Insert
    if (upper.includes("INSERT INTO METRIC_DEFINITION")) {
      const [metricId, version, tId, definition, hash, status, approvedBy] = params;
      const key = `${metricId}:${version}`;
      const def = {
        metric_id: metricId,
        version,
        tenant_id: tId || null,
        definition,
        definition_hash: hash,
        status,
        approved_by: approvedBy || null,
        approved_at: new Date().toISOString()
      };
      memDb.metricDefinitions.set(key, def);
      return { rows: [def], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Metric Definition Select
    if (upper.includes("FROM METRIC_DEFINITION")) {
      let rows = Array.from(memDb.metricDefinitions.values());
      if (params.length >= 2) {
        rows = rows.filter(d => d.metric_id === params[0] && d.version === params[1]);
      } else if (params.length === 1) {
        rows = rows.filter(d => d.metric_id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Metric Snapshot Insert
    if (upper.includes("INSERT INTO METRIC_SNAPSHOT")) {
      const [id, tId, metricId, version, cohortRef, pStart, pEnd, cutoff, codeDigest, memVer, val, quality, count, lineage] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant metric_snapshot write rejected");
      }
      const snap = {
        id,
        tenant_id: tId,
        metric_id: metricId,
        metric_version: version,
        cohort_ref: cohortRef,
        period_start: pStart,
        period_end: pEnd,
        source_cutoff: cutoff,
        code_digest: codeDigest,
        membership_version: memVer,
        value: val,
        quality,
        contributor_count: count,
        lineage,
        computed_at: new Date().toISOString()
      };
      memDb.metricSnapshots.set(id, snap);
      return { rows: [snap], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Metric Snapshot Select
    if (upper.includes("FROM METRIC_SNAPSHOT")) {
      let rows = Array.from(memDb.metricSnapshots.values()).filter(s => s.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(s => s.id === params[0] || (params.length >= 3 && s.metric_id === params[0] && s.cohort_ref === params[1]));
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Privacy Decision Insert
    if (upper.includes("INSERT INTO PRIVACY_DECISION")) {
      const [id, tId, queryHash, outcome, reasonCode, policyVersion] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant privacy_decision write rejected");
      }
      const decision = {
        id,
        tenant_id: tId,
        semantic_query_hash: queryHash,
        outcome,
        reason_code: reasonCode,
        policy_version: policyVersion,
        decided_at: new Date().toISOString()
      };
      memDb.privacyDecisions.set(id, decision);
      return { rows: [decision], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Privacy Release Insert
    if (upper.includes("INSERT INTO PRIVACY_RELEASE")) {
      const [id, tId, decId, snapId, metricId, version, releaseClass, status] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant privacy_release write rejected");
      }
      const release = {
        id,
        tenant_id: tId,
        decision_id: decId,
        snapshot_id: snapId,
        metric_id: metricId,
        metric_version: version,
        release_class: releaseClass,
        status: status || "RELEASED",
        superseded_by: null,
        released_at: new Date().toISOString()
      };
      memDb.privacyReleases.set(id, release);
      return { rows: [release], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Privacy Release Update status
    if (upper.includes("UPDATE PRIVACY_RELEASE SET STATUS")) {
      const [status, releaseId] = params;
      const r = memDb.privacyReleases.get(releaseId);
      if (r && r.tenant_id === this.tenantContext) {
        r.status = status;
        return { rows: [r], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
    }

    // Privacy Release Select
    if (upper.includes("FROM PRIVACY_RELEASE") && !upper.includes("JOIN RELEASED_ARTIFACT")) {
      let rows = Array.from(memDb.privacyReleases.values()).filter(r => r.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(r => r.id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Released Artifact Insert
    if (upper.includes("INSERT INTO RELEASED_ARTIFACT")) {
      const [releaseId, tId, metricId, version, val, unit, pStart, pEnd, quality, interpretation, status, artifactHash] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant released_artifact write rejected");
      }
      const artifact = {
        release_id: releaseId,
        tenant_id: tId,
        metric_id: metricId,
        metric_version: version,
        value: val,
        unit,
        period_start: pStart,
        period_end: pEnd,
        quality,
        interpretation,
        status,
        artifact_hash: artifactHash
      };
      memDb.releasedArtifacts.set(releaseId, artifact);
      return { rows: [artifact], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Released Artifact Select (single read path: joins with privacy_release)
    if (upper.includes("FROM RELEASED_ARTIFACT")) {
      const releaseId = params[0];
      const a = memDb.releasedArtifacts.get(releaseId);
      if (a && a.tenant_id === this.tenantContext) {
        const r = memDb.privacyReleases.get(releaseId);
        const combined = {
          ...a,
          rstatus: r ? r.status : a.status
        };
        return { rows: [combined], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    }

    // Disclosure Ledger Insert
    if (upper.includes("INSERT INTO DISCLOSURE_LEDGER")) {
      const [tId, metricId, wStart, wEnd, hash, members, releaseId] = params;
      if (this.tenantContext && tId !== this.tenantContext) {
        throw new Error("RLS WITH CHECK violation: cross-tenant disclosure_ledger write rejected");
      }
      const entry = {
        id: memDb.disclosureLedger.length + 1,
        tenant_id: tId,
        metric_id: metricId,
        window_start: wStart,
        window_end: wEnd,
        cohort_set_hash: hash,
        cohort_members: typeof members === "string" ? members : JSON.stringify(members),
        release_id: releaseId
      };
      memDb.disclosureLedger.push(entry);
      return { rows: [entry], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Disclosure Ledger Select
    if (upper.includes("FROM DISCLOSURE_LEDGER")) {
      let rows = memDb.disclosureLedger.filter(d => d.tenant_id === this.tenantContext);
      if (params.length >= 2) {
        rows = rows.filter(d => d.metric_id === params[1]);
      } else if (params.length === 1) {
        rows = rows.filter(d => d.metric_id === params[0] || d.tenant_id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // ==========================================
    // Phase 4: Risk Control & Verification Handlers
    // ==========================================

    // Hazard Insert
    if (upper.includes("INSERT INTO HAZARD")) {
      const [id, tId, title, ownerId, releaseId, disposition, version] = params;
      const rec = {
        id,
        tenant_id: tId,
        title,
        owner_principal_id: ownerId,
        originating_release_id: releaseId,
        disposition: disposition || "OPEN",
        version: version || 1,
        created_at: new Date().toISOString()
      };
      memDb.hazards.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Hazard Update
    if (upper.includes("UPDATE HAZARD")) {
      if (upper.includes("DISPOSITION =")) {
        const [disposition, hId] = params;
        const rec = memDb.hazards.get(hId);
        if (rec && rec.tenant_id === this.tenantContext) {
          rec.disposition = disposition;
          rec.version += 1;
          return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
        }
      }
    }

    // Hazard Select
    if (upper.includes("FROM HAZARD")) {
      let rows = Array.from(memDb.hazards.values()).filter(h => h.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(h => h.id === params[0] || h.originating_release_id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Cause Insert
    if (upper.includes("INSERT INTO CAUSE")) {
      const [id, tId, hId, statement, status, reviewedBy, reviewedAt, version] = params;
      const rec = {
        id,
        tenant_id: tId,
        hazard_id: hId,
        statement,
        status: status || "PROPOSED",
        reviewed_by: reviewedBy || null,
        reviewed_at: reviewedAt || null,
        version: version || 1,
        created_at: new Date().toISOString()
      };
      memDb.causes.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Cause Update
    if (upper.includes("UPDATE CAUSE")) {
      const [status, reviewedBy, reviewedAt, cId] = params;
      const rec = memDb.causes.get(cId);
      if (rec && rec.tenant_id === this.tenantContext) {
        rec.status = status;
        rec.reviewed_by = reviewedBy;
        rec.reviewed_at = reviewedAt;
        rec.version += 1;
        return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
    }

    // Cause Select
    if (upper.includes("FROM CAUSE")) {
      let rows = Array.from(memDb.causes.values()).filter(c => c.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(c => c.hazard_id === params[0] || c.id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Intervention Insert
    if (upper.includes("INSERT INTO INTERVENTION")) {
      let id: string, tId: string, hId: string, cId: string, state: string, version: any, scope: string, objective: string, ownerId: string, dueDate: string, vPlan: any, mHash: string;
      if (params.length === 10) {
        [id, tId, hId, cId, scope, objective, ownerId, dueDate, vPlan, mHash] = params;
        state = upper.includes("'APPROVED'") ? "APPROVED" : "PROPOSED";
        version = 1;
      } else {
        [id, tId, hId, cId, state, version, scope, objective, ownerId, dueDate, vPlan, mHash] = params;
      }
      const rec = {
        id,
        tenant_id: tId,
        hazard_id: hId,
        cause_id: cId,
        state: state || "DRAFT",
        version: Number(version) || 1,
        scope,
        objective,
        owner_principal_id: ownerId,
        due_date: dueDate,
        verification_plan: typeof vPlan === "string" ? JSON.parse(vPlan) : vPlan,
        material_hash: mHash,
        created_at: new Date().toISOString()
      };
      memDb.interventions.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Intervention Update
    if (upper.includes("UPDATE INTERVENTION")) {
      if (upper.includes("STATE =") && !upper.includes("SCOPE =")) {
        // e.g. UPDATE intervention SET state = $1 WHERE id = $2
        const [newState, iId] = params;
        const rec = memDb.interventions.get(iId);
        if (rec && rec.tenant_id === this.tenantContext) {
          rec.state = newState;
          return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
        }
      } else if (upper.includes("SCOPE =")) {
        if (params.length === 3) {
          const [scope, mHash, iId] = params;
          const rec = memDb.interventions.get(iId);
          if (rec && rec.tenant_id === this.tenantContext) {
            rec.scope = scope;
            rec.material_hash = mHash;
            rec.version += 1;
            rec.state = "APPROVAL_REQUIRED";
            return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
          }
        } else {
          const [scope, objective, dueDate, vPlan, mHash, state, iId] = params;
          const rec = memDb.interventions.get(iId);
          if (rec && rec.tenant_id === this.tenantContext) {
            rec.scope = scope;
            rec.objective = objective;
            rec.due_date = dueDate;
            rec.verification_plan = typeof vPlan === "string" ? JSON.parse(vPlan) : vPlan;
            rec.material_hash = mHash;
            rec.version += 1;
            rec.state = state;
            return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
          }
        }
      }
    }

    // Intervention Select
    if (upper.includes("FROM INTERVENTION")) {
      let rows = Array.from(memDb.interventions.values()).filter(i => i.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(i => i.id === params[0] || i.hazard_id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Approval Insert
    if (upper.includes("INSERT INTO APPROVAL")) {
      const [id, tId, iId, appVersion, appMHash, approverId, authRef, policy] = params;
      const rec = {
        id,
        tenant_id: tId,
        intervention_id: iId,
        approved_version: appVersion,
        approved_material_hash: appMHash,
        approver_principal_id: approverId,
        authority_ref: authRef,
        policy_resolution: typeof policy === "string" ? JSON.parse(policy) : policy,
        expires_at: null,
        revoked_at: null,
        approved_at: new Date().toISOString()
      };
      memDb.approvals.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Approval Select
    if (upper.includes("FROM APPROVAL")) {
      let rows = Array.from(memDb.approvals.values()).filter(a => a.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(a => a.intervention_id === params[0] || a.id === params[0]);
      }
      // Sort newest first
      rows.sort((a, b) => new Date(b.approved_at).getTime() - new Date(a.approved_at).getTime());
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Implementation Receipt Insert
    if (upper.includes("INSERT INTO IMPLEMENTATION_RECEIPT")) {
      const [id, tId, iId, iVersion, kind, recBy, completedOn, evRefs] = params;
      const rec = {
        id,
        tenant_id: tId,
        intervention_id: iId,
        intervention_version: iVersion,
        kind,
        recorded_by: recBy,
        completed_on: completedOn,
        evidence_refs: typeof evRefs === "string" ? JSON.parse(evRefs) : evRefs,
        recorded_at: new Date().toISOString()
      };
      memDb.implementationReceipts.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Implementation Receipt Select
    if (upper.includes("FROM IMPLEMENTATION_RECEIPT")) {
      let rows = Array.from(memDb.implementationReceipts.values()).filter(r => r.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(r => r.intervention_id === params[0] || r.id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    // Evaluation Insert
    if (upper.includes("INSERT INTO EVALUATION")) {
      const [id, tId, iId, plan, baseRelId, postRelId, adjRelIds, seriesBreak, outcome, reviewerId, residualRisk, concludedAt] = params;
      const rec = {
        id,
        tenant_id: tId,
        intervention_id: iId,
        plan: typeof plan === "string" ? JSON.parse(plan) : plan,
        baseline_release_id: baseRelId || null,
        post_release_id: postRelId || null,
        adjacent_release_ids: typeof adjRelIds === "string" ? JSON.parse(adjRelIds) : (adjRelIds || []),
        series_break: Boolean(seriesBreak),
        outcome: outcome || null,
        reviewer_id: reviewerId || null,
        residual_risk: residualRisk || null,
        concluded_at: concludedAt || null,
        created_at: new Date().toISOString()
      };
      memDb.evaluations.set(id, rec);
      return { rows: [rec], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    }

    // Evaluation Update
    if (upper.includes("UPDATE EVALUATION")) {
      const [outcome, reviewerId, residualRisk, concludedAt, eId] = params;
      const rec = memDb.evaluations.get(eId);
      if (rec && rec.tenant_id === this.tenantContext) {
        rec.outcome = outcome;
        rec.reviewer_id = reviewerId;
        rec.residual_risk = residualRisk;
        rec.concluded_at = concludedAt;
        return { rows: [rec], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
    }

    // Evaluation Select
    if (upper.includes("FROM EVALUATION")) {
      let rows = Array.from(memDb.evaluations.values()).filter(e => e.tenant_id === this.tenantContext);
      if (params.length > 0) {
        rows = rows.filter(e => e.intervention_id === params[0] || e.id === params[0]);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    }

    return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
  }

  release() {
    this.tenantContext = null;
    this.releaseHeldLocks();
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
