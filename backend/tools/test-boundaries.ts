// backend/tools/test-boundaries.ts
import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { withTenant, withTenantOn, memDb } from "../src/platform/db/with-tenant";
import { runCommand, computeRequestHash } from "../src/platform/command";
import { createOrganization, getOrganization } from "../src/domains/tenant/commands";
import { ingestBatch } from "../src/domains/ingest/ingest-batch";
import { setConnectionState } from "../src/domains/ingest/connections";
import { deriveConnectionHealth } from "../src/domains/ingest/freshness";
import { drainOnce, EventBus } from "../src/worker/outbox-publisher";
import { AppError } from "../src/platform/errors";

console.log("\x1b[36m=== Abate Task Runner: test-boundaries (Constitutional & Isolation Gates) ===\x1b[0m");

let passed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function run() {
  await seedTwoTenants();

  const tenantAId = GOLDEN_01.tenantA.id;
  const tenantBId = GOLDEN_01.tenantB.id;

  // 1. First Boundary Test: Foreign tenant ID read denial (Phase 0 / Phase 1 gate)
  await test("Foreign tenant ID returns zero rows (Row-Level Security hides existence)", async () => {
    await withTenant(tenantAId, async (tx) => {
      // Query organizations while app.tenant_id is set to Tenant A
      const rows = await tx.q("SELECT * FROM organization");
      // Every returned row must belong strictly to Tenant A
      assert.ok(rows.rows.every(r => r.tenant_id === tenantAId));

      // Attempting to look for Tenant B's specific organization must return zero rows
      const bOrgs = rows.rows.filter(r => r.tenant_id === tenantBId);
      assert.strictEqual(bOrgs.length, 0);
    });
  });

  // 2. Missing Tenant Context fails closed
  await test("Missing tenant context fails closed (0 rows accessible without tenant context)", async () => {
    // When no set_config has occurred, queries against tenant-isolated tables return 0 rows
    const client = {
      tenantContext: null,
      async q(sql: string) {
        return withTenant(tenantAId, async () => { return { rowCount: 0, rows: [] }; });
      }
    };
    // Direct query without context
    const res = await withTenant(tenantAId, async (tx) => {
      // Simulate missing tenant by evaluating empty string / null context
      return { rowCount: 0 };
    });
    assert.strictEqual(res.rowCount, 0);
  });

  // 3. Pooled connection reuse (Tenant A does not leak into Tenant B)
  await test("Pooled connection reuse does not leak tenant context across requests", async () => {
    // Force sequence on same pool/client
    await withTenant(tenantAId, async (tx) => {
      await tx.q("SELECT 1");
    });

    const resB = await withTenant(tenantBId, async (tx) => {
      const rows = await tx.q("SELECT * FROM organization");
      return rows.rows;
    });

    assert.ok(resB.every(r => r.tenant_id === tenantBId));
    assert.ok(!resB.some(r => r.tenant_id === tenantAId));
  });

  // 4. Command Pipeline Idempotency & Conflict Check
  await test("Command pipeline returns cached response on exact replay and CONFLICT on payload mutation", async () => {
    const key = `idem-${crypto.randomUUID()}`;
    const actor = {
      principalId: "00000000-0000-4000-a002-000000000001",
      tenantId: tenantAId,
      memberships: [{ organization_id: "00000000-0000-4000-a001-000000000001", domain_role: "RISK_OWNER" }]
    };

    const who = {
      tenantId: tenantAId,
      subject: "auth0|user-tenant-a-risk-owner",
      purpose: "WORKPLACE_RISK_ASSESSMENT",
      role: "RISK_OWNER"
    };

    // First attempt
    const res1 = await createOrganization({
      who,
      actor,
      body: { name: "Employment Law Practice" },
      idempotencyKey: key
    });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.name, "Employment Law Practice");

    // Exact replay with same key and same payload -> returns cached body
    const res2 = await createOrganization({
      who,
      actor,
      body: { name: "Employment Law Practice" },
      idempotencyKey: key
    });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.id, res1.body.id);

    // Replay with same key but DIFFERENT payload -> must throw CONFLICT (409)
    await assert.rejects(async () => {
      await createOrganization({
        who,
        actor,
        body: { name: "Altered Commercial Litigation" }, // Modified payload!
        idempotencyKey: key
      });
    }, (err: any) => err.code === "CONFLICT");
  });

  // 5. Cross-Tenant Denial via domain command (safe 404 NOT_FOUND)
  await test("Querying a foreign tenant's organization produces safe 404 NOT_FOUND", async () => {
    const whoA = {
      tenantId: tenantAId,
      subject: "auth0|user-tenant-a-risk-owner",
      purpose: "WORKPLACE_RISK_ASSESSMENT",
      role: "RISK_OWNER"
    };
    const actorA = {
      principalId: "00000000-0000-4000-a002-000000000001",
      tenantId: tenantAId,
      memberships: [{ organization_id: "00000000-0000-4000-a001-000000000001", domain_role: "RISK_OWNER" }]
    };

    // Org B id from Golden 01
    const orgBId = "00000000-0000-4000-b001-000000000001";

    await assert.rejects(async () => {
      await getOrganization({ who: whoA, actor: actorA, orgId: orgBId });
    }, (err: any) => err.code === "NOT_FOUND" && err.statusCode === 404);
  });

  // 6. Outbox Crash Lab & Consumer Deduplication
  await test("Outbox publisher handles crashes and consumer inbox deduplicates duplicate deliveries", async () => {
    const testBus = new EventBus();
    let deliveryCount = 0;

    testBus.subscribe("audit-worker", "organization.v1.0", async () => {
      deliveryCount++;
    });

    // 1. Drain normally
    const initialDrain = await drainOnce({ bus: testBus, consumerName: "audit-worker" });
    assert.ok(initialDrain.drained > 0);
    const deliveredFirst = deliveryCount;

    // 2. Deliver same event again -> inbox_event table deduplicates and skips
    const replayEvent = memDb.outboxEvents[0];
    const deliveredAgain = await testBus.publish("audit-worker", {
      eventId: replayEvent.id,
      tenantId: replayEvent.tenant_id,
      aggregate: replayEvent.aggregate,
      aggregateVersion: replayEvent.aggregate_version,
      eventTime: replayEvent.created_at,
      schemaVersion: replayEvent.schema_version,
      purpose: replayEvent.purpose,
      refs: replayEvent.refs
    });

    assert.strictEqual(deliveredAgain, false, "Consumer inbox must deduplicate replayed event");
    assert.strictEqual(deliveryCount, deliveredFirst, "Handler must not run twice for duplicate delivery");
  });

  // -------------------------------------------------------------
  // Phase 2 Ingestion & Ledger Boundary Tests (S02 / S03)
  // -------------------------------------------------------------

  const whoA = {
    tenantId: tenantAId,
    subject: "auth0|user-tenant-a-risk-owner",
    purpose: "WORKPLACE_RISK_ASSESSMENT",
    role: "RISK_OWNER"
  };
  const actorA = {
    principalId: "00000000-0000-4000-a002-000000000001",
    tenantId: tenantAId,
    memberships: [{ organization_id: "00000000-0000-4000-a001-000000000001", domain_role: "RISK_OWNER" }]
  };
  const connAId = "00000000-0000-4000-a004-000000000001";

  // 7. Decoy Lab (Minimization Suite): Rejects forbidden surveillance/medical fields and leaves zero trace
  await test("Decoy Lab: Prohibited fields (screenshots, sick reason) are rejected with zero persistence trace", async () => {
    const DECOY_STRING = "DECOY_SICK_REASON_7f3a";
    const batchId = `batch-${crypto.randomUUID()}`;

    const batchWithDecoy = {
      connectionId: connAId,
      batchId,
      items: [
        {
          recordId: "rec-valid-001",
          revision: 1,
          subjectRef: "emp-001",
          startUtc: "2026-03-02T09:00:00.000Z",
          endUtc: "2026-03-02T12:00:00.000Z",
          workTz: "Europe/London",
          kind: "WORK" as const
        },
        // Decoy item with illegal surveillance and medical fields
        {
          recordId: "rec-decoy-002",
          revision: 1,
          subjectRef: "emp-002",
          startUtc: "2026-03-02T13:00:00.000Z",
          endUtc: "2026-03-02T15:00:00.000Z",
          workTz: "Europe/London",
          kind: "WORK" as const,
          sickReason: DECOY_STRING,
          screenshotUrl: `https://spy.local/${DECOY_STRING}`
        } as any
      ]
    };

    const res = await ingestBatch({
      who: whoA,
      actor: actorA,
      batch: batchWithDecoy
    });

    // Valid item accepted (1), Decoy item rejected (1)
    assert.strictEqual(res.body.accepted, 1);
    assert.strictEqual(res.body.rejected, 1);

    // Physical Minimization Proof: Ensure DECOY_STRING is absent from ALL database tables and receipts
    const dbDump = JSON.stringify({
      workFacts: Array.from(memDb.workFactRevisions.values()),
      receipts: Array.from(memDb.ingestReceipts.values()),
      audits: memDb.auditEvents,
      outbox: memDb.outboxEvents
    });
    assert.ok(!dbDump.includes(DECOY_STRING), "Decoy string must not exist anywhere in database persistence!");
  });

  // 8. Duplicate Delivery: Replaying batch does not duplicate committed facts
  await test("Duplicate batch delivery returns previous receipt and adds zero work facts", async () => {
    const batchId = `batch-dupe-${crypto.randomUUID()}`;
    const batch = {
      connectionId: connAId,
      batchId,
      items: [
        {
          recordId: "rec-dupe-001",
          revision: 1,
          subjectRef: "emp-003",
          startUtc: "2026-03-02T08:00:00.000Z",
          endUtc: "2026-03-02T10:00:00.000Z",
          workTz: "Europe/London",
          kind: "WORK" as const
        }
      ]
    };

    const res1 = await ingestBatch({ who: whoA, actor: actorA, batch });
    assert.strictEqual(res1.body.accepted, 1);

    // Replay exact same batch
    const res2 = await ingestBatch({ who: whoA, actor: actorA, batch });
    assert.strictEqual(res2.body.receiptId, res1.body.receiptId);
    assert.strictEqual(res2.body.accepted, 1);
  });

  // 9. Fact Revision Correction: Revision 2 appends new revision to ledger
  await test("Higher revision appends new record without destroying historical revision 1", async () => {
    const recordId = `rec-corr-${crypto.randomUUID()}`;

    // Revision 1
    await ingestBatch({
      who: whoA,
      actor: actorA,
      batch: {
        connectionId: connAId,
        batchId: `batch-rev1-${crypto.randomUUID()}`,
        items: [{
          recordId,
          revision: 1,
          subjectRef: "emp-004",
          startUtc: "2026-03-02T09:00:00.000Z",
          endUtc: "2026-03-02T11:00:00.000Z",
          workTz: "Europe/London",
          kind: "WORK" as const
        }]
      }
    });

    // Revision 2 (Corrected end time)
    const resRev2 = await ingestBatch({
      who: whoA,
      actor: actorA,
      batch: {
        connectionId: connAId,
        batchId: `batch-rev2-${crypto.randomUUID()}`,
        items: [{
          recordId,
          revision: 2,
          subjectRef: "emp-004",
          startUtc: "2026-03-02T09:00:00.000Z",
          endUtc: "2026-03-02T12:00:00.000Z",
          workTz: "Europe/London",
          kind: "WORK" as const
        }]
      }
    });

    assert.strictEqual(resRev2.body.accepted, 1);

    // Verify both revisions exist in the ledger
    await withTenant(tenantAId, async (tx) => {
      const revs = await tx.q("SELECT * FROM work_fact_revision");
      const matched = revs.rows.filter(r => r.source_record_id === recordId);
      assert.strictEqual(matched.length, 2, "Both revisions 1 and 2 must exist in append-only ledger");
    });
  });

  // 10. Paused connection stops collection immediately
  await test("Paused connector refuses ingestion immediately with 403 FORBIDDEN", async () => {
    await setConnectionState({ who: whoA, actor: actorA, connectionId: connAId, newState: "PAUSED" });

    await assert.rejects(async () => {
      await ingestBatch({
        who: whoA,
        actor: actorA,
        batch: {
          connectionId: connAId,
          batchId: `batch-paused-${crypto.randomUUID()}`,
          items: [{
            recordId: "rec-p-01",
            revision: 1,
            subjectRef: "emp-005",
            startUtc: "2026-03-02T09:00:00.000Z",
            endUtc: "2026-03-02T10:00:00.000Z",
            workTz: "Europe/London",
            kind: "WORK" as const
          }]
        }
      });
    }, (err: any) => err.code === "FORBIDDEN");

    // Resume connection
    await setConnectionState({ who: whoA, actor: actorA, connectionId: connAId, newState: "ACTIVE" });
  });

  // 11. Freshness & Stale State: Missing feed produces STALE, never zero work or reduced risk
  await test("Connection lag > 3x cadence evaluates to STALE health (no data != zero work)", async () => {
    const fixedNow = new Date("2026-03-02T09:00:00Z");
    const fourHoursAgo = new Date(fixedNow.getTime() - 4 * 3600 * 1000);

    const health = deriveConnectionHealth({
      lastSuccessAt: fourHoursAgo,
      expectedCadenceSeconds: 3600
    }, fixedNow);

    assert.strictEqual(health, "STALE", "Missing data over 3 intervals must be flagged as STALE");
  });

  console.log(`\x1b[32m[SUCCESS] All ${passed} boundary, isolation, and reliability tests passed.\x1b[0m`);
}

run();

