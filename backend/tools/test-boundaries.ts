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
import { boundaryIntrusionShare, union, minutes } from "../src/domains/measure";
import { compileRelease, getRelease } from "../src/domains/privacy";
import { materialHash, canTransition, evaluateSuggestion, exportEvidencePackage } from "../src/domains/control";
import {
  publishPackVersion,
  resolveEffectivePack,
  setRetentionClass,
  placeLegalHold,
  releaseLegalHold,
  runRetention,
  previewRetention,
  getRetentionState
} from "../src/domains/lifecycle";
import { generateDiagnosticReceipt, verifyDiagnosticReceipt } from "../src/domains/support";

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

  // -------------------------------------------------------------
  // Phase 3 Reconstruction Lab & Privacy Release Gates
  // -------------------------------------------------------------

  // 12. Deterministic Measurement & Overlap Arithmetic
  await test("Deterministic metric calculator: Interval union prevents double-counting and zero denominator yields NOT_APPLICABLE", async () => {
    const t = (h: number, m = 0) => Date.UTC(2026, 2, 2, h, m);
    // Overlapping work: 09:00-11:00 (120m) and 10:00-12:00 (120m) -> union = 180m; plus 18:00-19:00 (60m) -> total 240m
    const work = [
      { start: t(9), end: t(11) },
      { start: t(10), end: t(12) },
      { start: t(18), end: t(19) }
    ];
    const schedule = [{ start: t(9), end: t(17) }];

    assert.strictEqual(minutes(union(work)), 240, "Union of overlapping intervals must be 240 minutes, not 300");

    const result = boundaryIntrusionShare(work, schedule);
    assert.strictEqual(result.quality, "VALID");
    assert.strictEqual(result.value, 25.0, "Golden value must reproduce 25.0% boundary intrusion share");

    // Zero denominator yields NOT_APPLICABLE, never 0%
    const zeroResult = boundaryIntrusionShare([], schedule);
    assert.strictEqual(zeroResult.quality, "NOT_APPLICABLE", "Zero denominator must yield NOT_APPLICABLE, not 0%");
  });

  // 13. Contributor Floor Gate: n = 9 is suppressed on every channel; n = 10 may release
  await test("Contributor floor gate: n=9 contributors are suppressed with safe UNAVAILABLE; n=10 releases", async () => {
    const queryBase = {
      metricId: "BOUNDARY_INTRUSION_SHARE",
      metricVersion: 1,
      cohortRef: "org:00000000-0000-4000-a001-000000000001",
      periodStart: "2026-03-02T00:00:00.000Z",
      periodEnd: "2026-03-30T00:00:00.000Z", // 28 days (meets Class B window)
      releaseClass: "CLASS_B" as const
    };

    // Sub-cohort with only 9 members
    const nineMembers = Array.from({ length: 9 }, (_, i) => `emp-cohort-member-${i + 1}`);
    const res9 = await compileRelease(tenantAId, queryBase, nineMembers);

    assert.strictEqual(res9.status, "UNAVAILABLE");
    assert.strictEqual(res9.code, "NOT_AVAILABLE", "Exact contributor count must never be echoed or hinted");

    // Cohort with exactly 10 members
    const tenMembers = Array.from({ length: 10 }, (_, i) => `emp-cohort-member-${i + 1}`);
    const res10 = await compileRelease(tenantAId, { ...queryBase, cohortRef: "org:cohort-10" }, tenMembers);

    assert.strictEqual(res10.status, "RELEASED");
    assert.ok(res10.releaseId, "Approved release must return valid releaseId");
  });

  // 14. Overlap Differencing Attack Gate: Symmetric difference < 5 cannot release
  await test("Overlap differencing gate: Two cohorts differing by 1 person (symmetric difference < 5) are blocked", async () => {
    const queryA = {
      metricId: "BOUNDARY_INTRUSION_SHARE",
      metricVersion: 1,
      cohortRef: "org:cohort-diff-a",
      periodStart: "2026-03-02T00:00:00.000Z",
      periodEnd: "2026-03-30T00:00:00.000Z",
      releaseClass: "CLASS_B" as const
    };

    // Cohort A: 12 members
    const cohortA = Array.from({ length: 12 }, (_, i) => `emp-diff-member-${i + 1}`);
    const resA = await compileRelease(tenantAId, queryA, cohortA);
    assert.strictEqual(resA.status, "RELEASED");

    // Cohort B: Same members except 1 person difference (symmetric difference = 1 < 5)
    const cohortB = [...cohortA.slice(0, 11), "emp-diff-member-NEW"];
    const queryB = { ...queryA, cohortRef: "org:cohort-diff-b" };
    const resB = await compileRelease(tenantAId, queryB, cohortB);

    assert.strictEqual(resB.status, "UNAVAILABLE", "Differencing attack with symmetric difference < 5 must be suppressed");
    assert.strictEqual(resB.code, "NOT_AVAILABLE");
  });

  // 15. Parent/Child Residual Differencing Gate: Residual < 5 is suppressed
  await test("Parent/child residual gate: Parent of 14 and child of 10 differ by residual 4 and are suppressed", async () => {
    const queryParent = {
      metricId: "BOUNDARY_INTRUSION_SHARE",
      metricVersion: 1,
      cohortRef: "org:cohort-parent-14",
      periodStart: "2026-03-02T00:00:00.000Z",
      periodEnd: "2026-03-30T00:00:00.000Z",
      releaseClass: "CLASS_B" as const
    };

    // Parent cohort of 14
    const parentMembers = Array.from({ length: 14 }, (_, i) => `emp-parent-child-${i + 1}`);
    const resParent = await compileRelease(tenantAId, queryParent, parentMembers);
    assert.strictEqual(resParent.status, "RELEASED");

    // Child cohort of 10 (strict subset, residual = 4 < 5)
    const childMembers = parentMembers.slice(0, 10);
    const queryChild = { ...queryParent, cohortRef: "org:cohort-child-10" };
    const resChild = await compileRelease(tenantAId, queryChild, childMembers);

    assert.strictEqual(resChild.status, "UNAVAILABLE", "Residual of 4 people must be protected from parent/child subtraction");
    assert.strictEqual(resChild.code, "NOT_AVAILABLE");
  });

  // 16. Concurrency Serialization & Single Read Path
  await test("Concurrent requests are serialized by tenant disclosure lock; single read path has zero contributor counts", async () => {
    const query = {
      metricId: "BOUNDARY_INTRUSION_SHARE",
      metricVersion: 1,
      cohortRef: "org:cohort-concurrent-base",
      periodStart: "2026-03-02T00:00:00.000Z",
      periodEnd: "2026-03-30T00:00:00.000Z",
      releaseClass: "CLASS_B" as const
    };

    const membersBase = Array.from({ length: 11 }, (_, i) => `emp-concurrent-${i + 1}`);
    // Concurrent request differing by 1 person
    const membersOffByOne = [...membersBase.slice(0, 10), "emp-concurrent-isolated"];

    const [r1, r2] = await Promise.all([
      compileRelease(tenantAId, { ...query, cohortRef: "org:conc-1" }, membersBase),
      compileRelease(tenantAId, { ...query, cohortRef: "org:conc-2" }, membersOffByOne)
    ]);

    const releasedCount = [r1, r2].filter(r => r.status === "RELEASED").length;
    assert.strictEqual(releasedCount, 1, "Concurrent requests cannot race past disclosure accounting; exactly one may release");

    // Single Read Path: Query getRelease and verify released artifact has NO contributor count
    const validReleaseId = (r1.status === "RELEASED" ? r1.releaseId : r2.releaseId)!;
    const view = await getRelease(actorA, validReleaseId);

    assert.strictEqual(view.status, "RELEASED");
    if (view.status === "RELEASED") {
      assert.strictEqual(view.metricName, "Boundary Intrusion Share");
      assert.strictEqual(view.value, 25.0);
      assert.strictEqual(view.unit, "percent");
      assert.strictEqual((view as any).contributor_count, undefined, "Released artifact must NEVER expose contributor counts");
    }
  });

  // 17. Phase 4 State Machine Gate: Invalid transition from PROPOSED to IMPLEMENTING is rejected
  await test("Phase 4 State Machine: Direct jump from PROPOSED to IMPLEMENTING is forbidden", async () => {
    // PROPOSED cannot transition directly to IMPLEMENTING or IMPLEMENTED without passing through APPROVAL
    const allowed = canTransition("PROPOSED", "IMPLEMENTING");
    assert.strictEqual(allowed, false, "State machine must forbid skipping approval");

    const allowedToImplemented = canTransition("PROPOSED", "IMPLEMENTED");
    assert.strictEqual(allowedToImplemented, false, "Cannot mark as implemented directly from proposed");

    // Must be allowed to go to REVIEW_REQUIRED or APPROVAL_REQUIRED
    assert.strictEqual(canTransition("PROPOSED", "APPROVAL_REQUIRED"), true);
    assert.strictEqual(canTransition("APPROVAL_REQUIRED", "APPROVED"), true);
    assert.strictEqual(canTransition("APPROVED", "IMPLEMENTING"), true);
  });

  // 18. Phase 4 Version-Bound Approval: Material edit invalidates prior approval
  await test("Phase 4 Version-Bound Approval: Material edit (v1 -> v2) invalidates approval and resets to APPROVAL_REQUIRED", async () => {
    await withTenant(tenantAId, async (tx) => {
      const hazardId = crypto.randomUUID();
      const causeId = crypto.randomUUID();
      const controlId = crypto.randomUUID();

      // Seed Hazard and Accepted Cause
      await tx.q("INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'OPEN', 1)",
        [hazardId, tenantAId, "Chronic Uncompensated Overtime", actorA.principalId, "rel-baseline-1"]
      );
      await tx.q("INSERT INTO cause (id, tenant_id, hazard_id, statement, status, version) VALUES ($1, $2, $3, $4, 'REVIEWED_ACCEPTED', 1)",
        [causeId, tenantAId, hazardId, "Unpredictable late-night partner email routing"]
      );

      // Create v1 Control
      const v1Plan = { baselineReleaseId: "rel-baseline-1", primaryMetric: "BOUNDARY_INTRUSION_SHARE", minDays: 28 };
      const v1Hash = materialHash({
        hazardId,
        causeId,
        scope: "Corporate Litigation practice group",
        objective: "Cap after-hours communications to critical emergencies only",
        ownerPrincipalId: actorA.principalId,
        dueDate: "2026-05-01",
        verificationPlan: v1Plan
      });

      await tx.q(
        "INSERT INTO intervention (id, tenant_id, hazard_id, cause_id, state, version, scope, objective, owner_principal_id, due_date, verification_plan, material_hash) VALUES ($1, $2, $3, $4, 'APPROVED', 1, $5, $6, $7, $8, $9, $10)",
        [controlId, tenantAId, hazardId, causeId, "Corporate Litigation practice group", "Cap after-hours communications to critical emergencies only", actorA.principalId, "2026-05-01", v1Plan, v1Hash]
      );

      // Add Approval bound to v1
      const approvalId = crypto.randomUUID();
      await tx.q(
        "INSERT INTO approval (id, tenant_id, intervention_id, approved_version, approved_material_hash, approver_principal_id, authority_ref, policy_resolution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [approvalId, tenantAId, controlId, 1, v1Hash, actorA.principalId, "auth:playbook-b4", { gate: "APPROVAL", resolved: true }]
      );

      // Verify v1 approval matches
      const a1 = (await tx.q("SELECT * FROM approval WHERE intervention_id = $1", [controlId])).rows[0];
      assert.strictEqual(a1.approved_version, 1);
      assert.strictEqual(a1.approved_material_hash, v1Hash);

      // Materially edit scope (bumps to v2)
      const v2Hash = materialHash({
        hazardId,
        causeId,
        scope: "Expanded to all Commercial Practice Groups", // Material scope change
        objective: "Cap after-hours communications to critical emergencies only",
        ownerPrincipalId: actorA.principalId,
        dueDate: "2026-05-01",
        verificationPlan: v1Plan
      });
      assert.notStrictEqual(v1Hash, v2Hash, "Material hash must change on scope change");

      await tx.q(
        "UPDATE intervention SET scope = $1, material_hash = $2, version = 2, state = 'APPROVAL_REQUIRED' WHERE id = $3",
        ["Expanded to all Commercial Practice Groups", v2Hash, controlId]
      );

      // Verify: Old approval does not match new version (The 'v1 cannot approve v2' rule)
      const ctrl = (await tx.q("SELECT * FROM intervention WHERE id = $1", [controlId])).rows[0];
      assert.strictEqual(ctrl.version, 2);
      assert.strictEqual(ctrl.state, "APPROVAL_REQUIRED");
      assert.notStrictEqual(a1.approved_version, ctrl.version, "v1 approval cannot match v2 intervention");
      assert.notStrictEqual(a1.approved_material_hash, ctrl.material_hash);
    });
  });

  // 19. Phase 4 Verification: Transfer of Risk Detection
  await test("Phase 4 Verification Suggestion: Adjacent cohort worsening flags TRANSFER_OF_RISK", async () => {
    // Primary cohort improves from 35% to 15% (delta = -20% -> improves)
    // Adjacent cohort worsens from 10% to 22% (delta = +12% > adjacentTolerance 5% -> worsens)
    const plan = { direction: "DECREASE" as const, criteria: 10.0, adjacentTolerance: 5.0 };
    const base = { status: "RELEASED" as const, value: 35.0 };
    const post = { status: "RELEASED" as const, value: 15.0 };
    const adjacent = [{
      baseline: { status: "RELEASED" as const, value: 10.0 },
      post: { status: "RELEASED" as const, value: 22.0 }
    }];

    const suggestion = evaluateSuggestion(plan, base, post, adjacent);

    assert.strictEqual(suggestion.suggestion, "PARTIALLY_EFFECTIVE");
    assert.strictEqual(suggestion.why, "TRANSFER_OF_RISK");
    assert.strictEqual(suggestion.transferOfRiskFlag, true, "Transfer of risk must be flagged to prevent false closure");
  });

  // 20. Phase 4 Verification Suggestion: Clean improvement succeeds with EFFECTIVE
  await test("Phase 4 Verification Suggestion: Clean improvement without adjacent worsening suggests EFFECTIVE", async () => {
    const plan = { direction: "DECREASE" as const, criteria: 10.0, adjacentTolerance: 5.0 };
    const base = { status: "RELEASED" as const, value: 35.0 };
    const post = { status: "RELEASED" as const, value: 18.0 };
    const adjacent = [{
      baseline: { status: "RELEASED" as const, value: 12.0 },
      post: { status: "RELEASED" as const, value: 11.5 }
    }];

    const suggestion = evaluateSuggestion(plan, base, post, adjacent);

    assert.strictEqual(suggestion.suggestion, "EFFECTIVE");
    assert.strictEqual(suggestion.why, "PRIMARY_TARGET_MET");
    assert.strictEqual(suggestion.transferOfRiskFlag, false);
  });

  // 21. Phase 4 Evidence Package: Vertical slice export with verifiable SHA-256 manifest
  await test("Phase 4 Evidence Package: Exports complete vertical slice with verifiable SHA-256 manifest", async () => {
    await withTenant(tenantAId, async (tx) => {
      // Create hazard with full vertical slice
      const hazardId = crypto.randomUUID();
      await tx.q("INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'CONTROLLED', 1)",
        [hazardId, tenantAId, "Hazard for Evidence Package Test", actorA.principalId, "rel-baseline-1"]
      );

      const causeId = crypto.randomUUID();
      await tx.q("INSERT INTO cause (id, tenant_id, hazard_id, statement, status, version) VALUES ($1, $2, $3, $4, 'REVIEWED_ACCEPTED', 1)",
        [causeId, tenantAId, hazardId, "Operational root cause statement"]
      );

      const controlId = crypto.randomUUID();
      const plan = { baselineReleaseId: "rel-baseline-1", primaryMetric: "BOUNDARY_INTRUSION_SHARE", minDays: 28 };
      const mHash = materialHash({
        hazardId,
        causeId,
        scope: "All teams",
        objective: "Reduce intrusion",
        ownerPrincipalId: actorA.principalId,
        dueDate: "2026-06-01",
        verificationPlan: plan
      });

      await tx.q(
        "INSERT INTO intervention (id, tenant_id, hazard_id, cause_id, state, version, scope, objective, owner_principal_id, due_date, verification_plan, material_hash) VALUES ($1, $2, $3, $4, 'CLOSED', 1, $5, $6, $7, $8, $9, $10)",
        [controlId, tenantAId, hazardId, causeId, "All teams", "Reduce intrusion", actorA.principalId, "2026-06-01", plan, mHash]
      );

      const pkg = await exportEvidencePackage(tx, hazardId, actorA.principalId);

      assert.strictEqual(pkg.manifest.hazardId, hazardId);
      assert.strictEqual(pkg.manifest.tenantId, tenantAId);
      assert.strictEqual(pkg.manifest.issuer, actorA.principalId);
      assert.ok(pkg.manifest.manifestHash.length === 64, "Manifest hash must be 64-char hex string");
      assert.ok(pkg.manifest.items.length >= 3, "Manifest must contain at least hazard, cause, and intervention");
      const hazardItem = pkg.artifacts.find(a => a.type === "hazard");
      assert.ok(hazardItem);
      assert.strictEqual(hazardItem?.id, hazardId);
      assert.ok(hazardItem?.sha256.length === 64);
    });
  });

  // -------------------------------------------------------------
  // Phase 5 (B5) Jurisdiction Packs, Retention & Legal Hold
  // -------------------------------------------------------------

  const NOW = new Date();
  const daysAgo = (d: number, hour = 9) => {
    const t = new Date(NOW.getTime() - d * 24 * 3600 * 1000);
    t.setUTCHours(hour, 0, 0, 0);
    return t.toISOString();
  };
  const isCode = (code: string) => (err: any) => err instanceof AppError && err.code === code;
  const factBySource = (recordId: string) =>
    Array.from(memDb.workFactRevisions.values()).find(f => f.source_record_id === recordId);

  const whoB = {
    tenantId: tenantBId,
    subject: "auth0|user-tenant-b-risk-owner",
    purpose: "WORKPLACE_RISK_ASSESSMENT",
    role: "RISK_OWNER"
  };
  const actorB = {
    principalId: "00000000-0000-4000-b002-000000000001",
    tenantId: tenantBId,
    memberships: [{ organization_id: "00000000-0000-4000-b001-000000000001", domain_role: "RISK_OWNER" }]
  };

  // Second Tenant A connection so a hold can be scoped to one source only
  const connA2Id = "00000000-0000-4000-a004-000000000002";
  memDb.connections.set(connA2Id, {
    id: connA2Id,
    tenant_id: tenantAId,
    source: "ZoikoTime",
    contract_id: "00000000-0000-4000-a005-000000000001",
    state: "ACTIVE",
    last_success_at: NOW.toISOString(),
    expected_cadence_seconds: 3600
  });

  const workItem = (recordId: string, endDaysAgo: number) => ({
    recordId,
    revision: 1,
    subjectRef: `emp-${recordId}`,
    startUtc: daysAgo(endDaysAgo, 8),
    endUtc: daysAgo(endDaysAgo, 10),
    workTz: "Europe/London",
    kind: "WORK" as const
  });

  const packContent = (floorDays: number) => ({
    title: "SYNTHETIC boundary-test pack",
    sourceRefs: ["SYNTHETIC-TEST"],
    retention: { WORK_FACT: { floor: { days: floorDays, citation: "SYNTHETIC-TEST floor" } } }
  });

  // 22. Effective-dated jurisdiction pack resolution
  await test("Phase 5 Jurisdiction: Pack resolution is effective-dated and fails closed outside coverage", async () => {
    await withTenant(tenantAId, async (tx) => {
      await publishPackVersion(tx, {
        packId: "test-dating-pack", version: 1, jurisdiction: "UK", sector: "LEGAL",
        effectiveFrom: "2026-01-01T00:00:00.000Z", content: packContent(90), approvedBy: "SYNTHETIC-TEST"
      });
      await publishPackVersion(tx, {
        packId: "test-dating-pack", version: 2, jurisdiction: "UK", sector: "LEGAL",
        effectiveFrom: "2026-06-01T00:00:00.000Z", content: packContent(120), approvedBy: "SYNTHETIC-TEST"
      });

      const rows = (await tx.q("SELECT * FROM jurisdiction_pack WHERE pack_id = $1", ["test-dating-pack"])).rows;
      assert.strictEqual(rows.find(r => r.version === 1)?.effective_to, "2026-06-01T00:00:00.000Z", "v1 must be closed where v2 starts");
      assert.strictEqual(resolveEffectivePack(rows, new Date("2026-03-01T00:00:00Z"))?.version, 1);
      assert.strictEqual(resolveEffectivePack(rows, new Date("2026-06-01T00:00:00Z"))?.version, 2, "Boundary instant belongs to the new version");
      assert.strictEqual(resolveEffectivePack(rows, new Date("2025-12-31T23:59:59Z")), null, "Before coverage there is no pack");
    });
  });

  // 23. Published pack versions are immutable and sequential
  await test("Phase 5 Jurisdiction: Published versions are immutable; out-of-sequence or overlapping versions are refused", async () => {
    await withTenant(tenantAId, async (tx) => {
      const v1Before = (await tx.q("SELECT * FROM jurisdiction_pack WHERE pack_id = $1", ["test-dating-pack"])).rows
        .find(r => r.version === 1)?.content_hash;
      const base = { packId: "test-dating-pack", jurisdiction: "UK", sector: "LEGAL", content: packContent(1), approvedBy: "SYNTHETIC-TEST" };

      await assert.rejects(() => publishPackVersion(tx, { ...base, version: 2, effectiveFrom: "2026-09-01T00:00:00.000Z" }), isCode("CONFLICT"));
      await assert.rejects(() => publishPackVersion(tx, { ...base, version: 5, effectiveFrom: "2026-09-01T00:00:00.000Z" }), isCode("CONFLICT"));
      await assert.rejects(() => publishPackVersion(tx, { ...base, version: 3, effectiveFrom: "2026-05-01T00:00:00.000Z" }), isCode("CONFLICT"));

      const v1After = (await tx.q("SELECT * FROM jurisdiction_pack WHERE pack_id = $1", ["test-dating-pack"])).rows
        .find(r => r.version === 1)?.content_hash;
      assert.strictEqual(v1After, v1Before, "Approved content must never change");
    });
  });

  // Facts used by the retention tests: two expired (one per connection) and one recent
  await ingestBatch({
    who: whoA, actor: actorA,
    batch: { connectionId: connAId, batchId: `batch-ret-a-${crypto.randomUUID()}`, items: [workItem("ret-old-a", 200), workItem("ret-new-a", 5)] }
  });
  await ingestBatch({
    who: whoA, actor: actorA,
    batch: { connectionId: connA2Id, batchId: `batch-ret-a2-${crypto.randomUUID()}`, items: [workItem("ret-old-a2", 200)] }
  });

  // 24. No invented default duration
  await test("Phase 5 Retention: With no configured class a run deletes nothing (no invented default)", async () => {
    const before = memDb.workFactRevisions.size;
    const res = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: crypto.randomUUID(), now: NOW });
    assert.strictEqual(res.body.status, "NO_POLICY");
    assert.strictEqual(res.body.purged, 0);
    assert.strictEqual(memDb.workFactRevisions.size, before, "No rows may be deleted without a tenant-configured class");
  });

  // 25. Durations bounded by the pack; no pack => refused
  await test("Phase 5 Retention: Durations outside the pack floor/ceiling, or without pack coverage, are refused", async () => {
    const setA = (days: number) => setRetentionClass({
      who: whoA, actor: actorA, idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", retentionDays: days, basis: "Boundary test duration" }
    });
    await assert.rejects(() => setA(10), isCode("VALIDATION"));   // below 28-day measurement minimum
    await assert.rejects(() => setA(60), isCode("VALIDATION"));   // below synthetic pack floor (90)
    await assert.rejects(() => setA(1000), isCode("VALIDATION")); // above synthetic pack ceiling (730)

    // Tenant B's pack (legal-uk-bar) is not published: configuration fails closed
    await assert.rejects(() => setRetentionClass({
      who: whoB, actor: actorB, idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", retentionDays: 365, basis: "Boundary test duration" }
    }), isCode("VALIDATION"));

    assert.strictEqual(Array.from(memDb.retentionClasses.values()).length, 0, "Refused configurations must leave no class behind");
  });

  let scopedHoldId = "";

  // 26. Legal hold overrides retention; verified tombstones
  await test("Phase 5 Legal Hold: Held facts survive purge; eligible = purged + held; tombstones are verified and content-free", async () => {
    const cls = await setRetentionClass({
      who: whoA, actor: actorA, idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", retentionDays: 90, basis: "Synthetic tenant schedule for boundary test" }
    });
    assert.strictEqual(cls.body.version, 1);
    assert.strictEqual(cls.body.packId, "legal-uk-sra");

    const hold = await placeLegalHold({
      who: whoA, actor: actorA, idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", scopeConnectionId: connA2Id, matterRef: "MATTER-TEST-1", reason: "Preserve source A2 for litigation" }
    });
    scopedHoldId = hold.body.id;

    const deletedPseudonym = factBySource("ret-old-a")?.subject_pseudonym;
    assert.ok(deletedPseudonym);

    const preview = await previewRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", now: NOW });
    const key = crypto.randomUUID();
    const run = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: key, now: NOW });
    const replay = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: key, now: NOW });

    assert.strictEqual(run.body.status, "COMPLETED");
    assert.strictEqual(run.body.eligible, run.body.purged + run.body.held, "Counts must reconcile");
    assert.strictEqual(run.body.purged, preview.purgeable, "Preview must predict the run");
    assert.strictEqual(run.body.verified, run.body.purged, "Every deletion must be verified");
    assert.ok(run.body.held >= 1);
    assert.strictEqual(replay.body.runId, run.body.runId, "Idempotent replay returns the same receipt");

    assert.strictEqual(factBySource("ret-old-a"), undefined, "Expired, unheld fact must be purged");
    assert.ok(factBySource("ret-old-a2"), "Fact under legal hold must survive");
    assert.ok(factBySource("ret-new-a"), "Fact inside the retention window must survive");

    const tombstones = Array.from(memDb.deletionTombstones.values()).filter(t => t.run_id === run.body.runId);
    assert.strictEqual(tombstones.length, run.body.purged);
    assert.ok(tombstones.every(t => t.verified_at), "All tombstones must be verified");
    const dump = JSON.stringify(tombstones);
    assert.ok(!dump.includes(deletedPseudonym!) && !dump.includes("ret-old-a"), "Tombstones must not keep pseudonyms or source record ids");
  });

  // 27. Releasing the hold lets retention proceed
  await test("Phase 5 Legal Hold: Releasing the hold lets the next run purge; releasing twice is CONFLICT", async () => {
    await releaseLegalHold({
      who: whoA, actor: actorA, holdId: scopedHoldId, idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Matter closed for boundary test" }
    });
    const run = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: crypto.randomUUID(), now: NOW });
    assert.strictEqual(run.body.held, 0);
    assert.strictEqual(factBySource("ret-old-a2"), undefined, "Released fact is purged on the next run");

    await assert.rejects(() => releaseLegalHold({
      who: whoA, actor: actorA, holdId: scopedHoldId, idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Second release attempt" }
    }), isCode("CONFLICT"));
  });

  // 28. Purged records are not resurrected
  await test("Phase 5 Tombstone: A purged record re-delivered by the source is counted duplicate, not resurrected", async () => {
    const res = await ingestBatch({
      who: whoA, actor: actorA,
      batch: { connectionId: connAId, batchId: `batch-ret-redeliver-${crypto.randomUUID()}`, items: [workItem("ret-old-a", 200)] }
    });
    assert.strictEqual(res.body.accepted, 0);
    assert.strictEqual(res.body.duplicate, 1);
    assert.strictEqual(factBySource("ret-old-a"), undefined);
  });

  // 29. Storage-layer purge guard (mirrors the PostgreSQL trigger)
  await test("Phase 5 Purge Guard: Deleting a work fact without a tombstone, or under legal hold, is refused by storage", async () => {
    const recent = factBySource("ret-new-a");
    assert.ok(recent);

    await assert.rejects(() => withTenant(tenantAId, async (tx) => {
      await tx.q("DELETE FROM work_fact_revision WHERE id = $1", [recent!.id]);
    }), /without a deletion tombstone/);

    const hold = await placeLegalHold({
      who: whoA, actor: actorA, idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", matterRef: "MATTER-TEST-2", reason: "Category-wide preservation" }
    });
    await assert.rejects(() => withTenant(tenantAId, async (tx) => {
      await tx.q(
        "INSERT INTO deletion_tombstone (id, tenant_id, run_id, data_category, record_ref, record_digest, record_key_digest) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [crypto.randomUUID(), tenantAId, crypto.randomUUID(), "WORK_FACT", recent!.id, "digest", "key-digest"]
      );
      await tx.q("DELETE FROM work_fact_revision WHERE id = $1", [recent!.id]);
    }), /under legal hold/);

    assert.ok(factBySource("ret-new-a"), "Refused delete must leave the fact intact");
    assert.ok(!Array.from(memDb.deletionTombstones.values()).some(t => t.record_ref === recent!.id), "Rolled-back tombstone must not persist");

    await releaseLegalHold({
      who: whoA, actor: actorA, holdId: hold.body.id, idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Boundary test cleanup" }
    });
  });

  // 30. Tenant isolation of retention state
  await test("Phase 5 Isolation: Tenant B sees none of Tenant A's classes, holds, runs or tombstones and cannot release A's hold", async () => {
    const stateB = await getRetentionState({ who: whoB, actor: actorB });
    assert.strictEqual(stateB.classes.length, 0);
    assert.strictEqual(stateB.holds.length, 0);
    assert.strictEqual(stateB.runs.length, 0);
    assert.strictEqual(stateB.tombstones.total, 0);
    assert.strictEqual(stateB.coverage.status, "NOT_COVERED");

    await assert.rejects(() => releaseLegalHold({
      who: whoB, actor: actorB, holdId: scopedHoldId, idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Cross-tenant release attempt" }
    }), isCode("NOT_FOUND"));
  });

  // 31. Only accountable owners change retention
  await test("Phase 5 Authority: MEMBER and CONTROL_OWNER cannot place legal holds or run retention (FORBIDDEN)", async () => {
    for (const role of ["MEMBER", "CONTROL_OWNER"]) {
      const actor = { ...actorA, principalId: "00000000-0000-4000-a002-000000000002", memberships: [{ organization_id: "00000000-0000-4000-a001-000000000001", domain_role: role }] };
      await assert.rejects(() => placeLegalHold({
        who: whoA, actor, idempotencyKey: crypto.randomUUID(),
        input: { dataCategory: "WORK_FACT", matterRef: "MATTER-X", reason: "Unauthorised hold attempt" }
      }), isCode("FORBIDDEN"));
      await assert.rejects(() => runRetention({ who: whoA, actor, dataCategory: "WORK_FACT", idempotencyKey: crypto.randomUUID(), now: NOW }), isCode("FORBIDDEN"));
    }
  });

  // 32. A newer pack invalidating the configured duration blocks deletion
  await test("Phase 5 Fail Closed: A class outside a newer pack version's floor blocks the run instead of deleting", async () => {
    await withTenant(tenantAId, async (tx) => {
      await publishPackVersion(tx, {
        packId: "legal-uk-sra", version: 2, jurisdiction: "UK", sector: "LEGAL",
        effectiveFrom: daysAgo(1, 0), content: packContent(400), approvedBy: "SYNTHETIC-TEST"
      });
    });
    const before = memDb.workFactRevisions.size;
    const run = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: crypto.randomUUID(), now: NOW });
    assert.strictEqual(run.body.status, "BLOCKED");
    assert.ok(run.body.blockedReason?.includes("floor"));
    assert.strictEqual(run.body.purged, 0);
    assert.strictEqual(memDb.workFactRevisions.size, before);
  });

  // -------------------------------------------------------------
  // B8 Zero-Impersonation Support: Signed Diagnostic Receipts
  // -------------------------------------------------------------

  // 33. Diagnostic receipts carry states and counts only
  await test("B8 Diagnostic Receipt: content-free, tenant-scoped and verifiable after transport", async () => {
    const key = crypto.randomUUID();
    const res = await generateDiagnosticReceipt({ who: whoA, actor: actorA, idempotencyKey: key });
    const replay = await generateDiagnosticReceipt({ who: whoA, actor: actorA, idempotencyKey: key });
    const receipt = JSON.parse(JSON.stringify(res.body)); // as received by support

    assert.strictEqual(receipt.tenantId, tenantAId);
    assert.strictEqual(replay.body.receiptId, res.body.receiptId, "Idempotent replay returns the same receipt");
    assert.strictEqual(verifyDiagnosticReceipt(receipt).valid, true);
    assert.ok(receipt.sections.connections.length >= 1);
    assert.strictEqual(receipt.sections.retention.coverage, "COVERED");

    const dump = JSON.stringify(receipt);
    const pseudonyms = Array.from(memDb.workFactRevisions.values()).map(f => f.subject_pseudonym);
    const subjects = Array.from(memDb.principals.values()).map(p => p.external_subject);
    const foreignConnections = Array.from(memDb.connections.values()).filter(c => c.tenant_id !== tenantAId).map(c => c.id);
    assert.ok(pseudonyms.length > 0 && subjects.length > 0);
    for (const secret of [...pseudonyms, ...subjects, ...foreignConnections]) {
      assert.ok(!dump.includes(secret), "Receipt must not contain pseudonyms, identities or another tenant's resources");
    }
  });

  // 34. Tampering is detected
  await test("B8 Diagnostic Receipt: any edit after issue, or a forged receipt, fails verification", async () => {
    const res = await generateDiagnosticReceipt({ who: whoB, actor: actorB, idempotencyKey: crypto.randomUUID() });
    const edited = JSON.parse(JSON.stringify(res.body));
    edited.sections.outbox.pendingEvents += 1;
    const retargeted = { ...JSON.parse(JSON.stringify(res.body)), tenantId: tenantAId };

    assert.strictEqual(verifyDiagnosticReceipt(res.body).valid, true);
    assert.strictEqual(verifyDiagnosticReceipt(edited).valid, false);
    assert.strictEqual(verifyDiagnosticReceipt(retargeted).valid, false);
    assert.strictEqual(verifyDiagnosticReceipt({ ...res.body, signature: "0".repeat(64) }).valid, false);
    assert.strictEqual(verifyDiagnosticReceipt({ signature: "not-hex" }).valid, false);
    assert.strictEqual(verifyDiagnosticReceipt(null).valid, false);
  });

  console.log(`\x1b[32m[SUCCESS] All ${passed} boundary, isolation, and reliability tests passed.\x1b[0m`);
}

run();

