// backend/tools/test-phase5-retention.ts
// Phase 5 Retention & Jurisdiction Pack Enforcement Test Suite (Specification BE-006)
// Architecture Ref: ZAB-ENG-001 v1.0 / Package B5 (Domains S04 & S06) & ADR-005
//
// Verifies:
// 1. Effective-dated jurisdiction pack resolution (fails closed outside coverage window)
// 2. Published pack versions are strictly immutable and sequential (fail closed on duplicate/overlap)
// 3. No invented platform default retention duration (NO_POLICY receipt, 0 deleted rows)
// 4. Tenant retention duration bounded by active jurisdiction pack floor/ceiling (VALIDATION failure)
// 5. Legal hold overrides retention purge (held facts survive; eligible = purged + held)
// 6. Cryptographic deletion tombstones with re-read verification (zero pseudonyms in tombstones)
// 7. Legal hold release lifecycle (permits subsequent purge; double release yields CONFLICT)
// 8. Anti-resurrection guard (re-ingested purged records classified as DUPLICATE)
// 9. Storage-layer purge guard (direct DELETE without tombstone or under active hold is refused)

import assert from "node:assert";
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, authenticate, resolveActor } from "../src/domains/tenant/auth";
import { withTenant, memDb } from "../src/platform/db/with-tenant";
import { publishPackVersion } from "../src/domains/lifecycle/jurisdiction";
import { resolveEffectivePack } from "../src/domains/lifecycle/policy";
import {
  setRetentionClass,
  placeLegalHold,
  releaseLegalHold,
  runRetention,
  previewRetention,
  getRetentionState
} from "../src/domains/lifecycle/retention";
import { ingestBatch } from "../src/domains/ingest/ingest-batch";
import { AppError } from "../src/platform/errors";

console.log("\x1b[36m=== Abate Task Runner: test-phase5-retention (BE-006 Retention & Jurisdiction Lifecycle) ===\x1b[0m\n");

let passed = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      await res;
    }
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    process.exit(1);
  }
}

const isCode = (code: string) => (err: any) => err?.code === code || (err instanceof AppError && err.code === code);

async function main() {
  // Step 0: Seed base multi-tenant environment
  await runTest("Setup: Seed isolated two-tenant environment", async () => {
    await seedTwoTenants();
  });

  const tenantAId = GOLDEN_01.tenantA.id;
  const tenantBId = GOLDEN_01.tenantB.id;

  const tokenA = createDevToken({
    tenantId: tenantAId,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  });
  const whoA = await authenticate(`Bearer ${tokenA}`);
  const actorA = await resolveActor(whoA.tenantId, whoA.subject);

  const tokenB = createDevToken({
    tenantId: tenantBId,
    subject: "auth0|user-tenant-b-risk-owner",
    role: "RISK_OWNER",
    purpose: "WORKPLACE_RISK_ASSESSMENT"
  });
  const whoB = await authenticate(`Bearer ${tokenB}`);
  const actorB = await resolveActor(whoB.tenantId, whoB.subject);

  const connAId = "00000000-0000-4000-a004-000000000001";
  const connA2Id = "00000000-0000-4000-a004-000000000002";
  memDb.connections.set(connA2Id, {
    id: connA2Id,
    tenant_id: tenantAId,
    source: "ZoikoTime",
    contract_id: "00000000-0000-4000-a005-000000000001",
    state: "ACTIVE",
    last_success_at: new Date().toISOString(),
    expected_cadence_seconds: 3600
  });

  const NOW = new Date();
  const daysAgo = (d: number, hour = 9) => {
    const t = new Date(NOW.getTime() - d * 24 * 3600 * 1000);
    t.setUTCHours(hour, 0, 0, 0);
    return t.toISOString();
  };

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
    retention: { WORK_FACT: { floor: { days: floorDays, citation: "SYNTHETIC-TEST floor" } } }
  });
  const packMeta = {
    kind: "JURISDICTION" as const,
    sourceRefs: ["SYNTHETIC-TEST"],
    accountableReviewer: "SYNTHETIC-TEST",
    reviewDate: "2027-01-01"
  };

  const factBySource = (recordId: string) =>
    Array.from(memDb.workFactRevisions.values()).find(f => f.source_record_id === recordId);

  // Test 1: Effective-dated jurisdiction pack resolution
  await runTest("Test 1: Effective-dated jurisdiction pack resolution fails closed outside coverage", async () => {
    await withTenant(tenantAId, async (tx) => {
      await publishPackVersion(tx, {
        ...packMeta,
        packKey: "test-dating-pack",
        version: 1,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        content: packContent(90)
      });
      await publishPackVersion(tx, {
        ...packMeta,
        packKey: "test-dating-pack",
        version: 2,
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        content: packContent(120)
      });

      const rows = (await tx.q("SELECT * FROM policy_pack WHERE pack_key = $1", ["test-dating-pack"])).rows;
      assert.strictEqual(rows.find((r: any) => r.version === 1)?.effective_to, "2026-06-01T00:00:00.000Z", "v1 must be closed where v2 starts");
      assert.strictEqual(resolveEffectivePack(rows, new Date("2026-03-01T00:00:00Z"))?.version, 1, "Date inside v1 window returns v1");
      assert.strictEqual(resolveEffectivePack(rows, new Date("2026-06-01T00:00:00Z"))?.version, 2, "Boundary instant belongs to new version");
      assert.strictEqual(resolveEffectivePack(rows, new Date("2025-12-31T23:59:59Z")), null, "Instant prior to coverage fails closed");
    });
  });

  // Test 2: Published pack versions are strictly immutable and sequential
  await runTest("Test 2: Published pack versions are strictly immutable and sequential", async () => {
    await withTenant(tenantAId, async (tx) => {
      const v1Before = (await tx.q("SELECT * FROM policy_pack WHERE pack_key = $1", ["test-dating-pack"])).rows
        .find((r: any) => r.version === 1)?.content_hash;
      const base = { ...packMeta, packKey: "test-dating-pack", content: packContent(1) };

      // Duplicate version 2
      await assert.rejects(() => publishPackVersion(tx, { ...base, version: 2, effectiveFrom: "2026-09-01T00:00:00.000Z" }), isCode("CONFLICT"));
      // Out of order version 5 (must be strictly sequential)
      await assert.rejects(() => publishPackVersion(tx, { ...base, version: 5, effectiveFrom: "2026-09-01T00:00:00.000Z" }), isCode("CONFLICT"));
      // Overlapping earlier timestamp
      await assert.rejects(() => publishPackVersion(tx, { ...base, version: 3, effectiveFrom: "2026-05-01T00:00:00.000Z" }), isCode("CONFLICT"));

      const v1After = (await tx.q("SELECT * FROM policy_pack WHERE pack_key = $1", ["test-dating-pack"])).rows
        .find((r: any) => r.version === 1)?.content_hash;
      assert.strictEqual(v1After, v1Before, "Approved content hash must be strictly immutable");
    });
  });

  // Ingest baseline facts for retention testing
  await ingestBatch({
    who: whoA,
    actor: actorA,
    batch: {
      connectionId: connAId,
      batchId: `batch-ret-a-${crypto.randomUUID()}`,
      items: [workItem("ret-old-a", 200), workItem("ret-new-a", 5)]
    }
  });
  await ingestBatch({
    who: whoA,
    actor: actorA,
    batch: {
      connectionId: connA2Id,
      batchId: `batch-ret-a2-${crypto.randomUUID()}`,
      items: [workItem("ret-old-a2", 200)]
    }
  });

  // Test 3: No invented platform default retention duration
  await runTest("Test 3: Zero invented defaults (runs without tenant class delete nothing)", async () => {
    const before = memDb.workFactRevisions.size;
    const res = await runRetention({
      who: whoA,
      actor: actorA,
      dataCategory: "WORK_FACT",
      idempotencyKey: crypto.randomUUID(),
      now: NOW
    });
    assert.strictEqual(res.body.status, "NO_POLICY");
    assert.strictEqual(res.body.purged, 0);
    assert.strictEqual(memDb.workFactRevisions.size, before, "No records may be deleted without configured tenant class");
  });

  // Test 4: Tenant retention duration bounds enforcement
  await runTest("Test 4: Durations outside pack floor/ceiling or without pack coverage fail closed", async () => {
    const setA = (days: number) => setRetentionClass({
      who: whoA,
      actor: actorA,
      idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", retentionDays: days, basis: "Boundary test duration" }
    });

    await assert.rejects(() => setA(10), isCode("VALIDATION"));   // Below 28-day measurement minimum
    await assert.rejects(() => setA(60), isCode("VALIDATION"));   // Below synthetic pack floor (90)
    await assert.rejects(() => setA(1000), isCode("VALIDATION")); // Above synthetic pack ceiling (730)

    // Tenant B's pack does not address WORK_FACT: fails closed
    await assert.rejects(() => setRetentionClass({
      who: whoB,
      actor: actorB,
      idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", retentionDays: 365, basis: "Boundary test duration" }
    }), isCode("VALIDATION"));

    assert.strictEqual(Array.from(memDb.retentionClasses.values()).length, 0, "Refused configurations leave no class behind");
  });

  let scopedHoldId = "";

  // Test 5: Legal hold override protections & reconciled counts
  await runTest("Test 5: Legal hold overrides retention; eligible = purged + held", async () => {
    const cls = await setRetentionClass({
      who: whoA,
      actor: actorA,
      idempotencyKey: crypto.randomUUID(),
      input: { dataCategory: "WORK_FACT", retentionDays: 90, basis: "Tenant retention schedule" }
    });
    assert.strictEqual(cls.body.version, 1);
    assert.strictEqual(cls.body.status, "ACTIVE");

    const hold = await placeLegalHold({
      who: whoA,
      actor: actorA,
      idempotencyKey: crypto.randomUUID(),
      input: {
        dataCategory: "WORK_FACT",
        scopeConnectionId: connA2Id,
        matterRef: "MATTER-PHASE5-01",
        reason: "Preserve connection A2 for litigation"
      }
    });
    scopedHoldId = hold.body.id;

    const preview = await previewRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", now: NOW });
    const runKey = crypto.randomUUID();
    const run = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: runKey, now: NOW });
    const replay = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: runKey, now: NOW });

    assert.strictEqual(run.body.status, "COMPLETED");
    assert.strictEqual(run.body.eligible, run.body.purged + run.body.held, "Purge accounting must reconcile (eligible = purged + held)");
    assert.strictEqual(run.body.purged, preview.purgeable, "Preview must exactly predict run outcome");
    assert.strictEqual(run.body.verified, run.body.purged, "Every deletion must be verified by immediate re-read");
    assert.ok(run.body.held >= 1, "Held item count must be positive");
    assert.strictEqual(replay.body.runId, run.body.runId, "Idempotent execution returns identical receipt");

    assert.strictEqual(factBySource("ret-old-a"), undefined, "Expired, unheld fact must be purged");
    assert.ok(factBySource("ret-old-a2"), "Fact under legal hold must survive purge");
    assert.ok(factBySource("ret-new-a"), "Recent fact within retention window must survive purge");
  });

  // Test 6: Cryptographic tombstones hold zero employee identifiers
  await runTest("Test 6: Tombstones hold cryptographic digests only (zero pseudonyms or source IDs)", async () => {
    const tombstones = Array.from(memDb.deletionTombstones.values());
    assert.ok(tombstones.length > 0, "Deletion tombstones must be present");
    assert.ok(tombstones.every(t => t.verified_at), "All tombstones must have verified_at timestamp");

    const dump = JSON.stringify(tombstones);
    assert.ok(!dump.includes("emp-ret-old-a"), "Tombstones must NEVER leak subject pseudonym");
    assert.ok(!dump.includes("ret-old-a"), "Tombstones must NEVER leak source record ID");
  });

  // Test 7: Legal hold release lifecycle
  await runTest("Test 7: Releasing legal hold permits subsequent purge; double release fails with CONFLICT", async () => {
    await releaseLegalHold({
      who: whoA,
      actor: actorA,
      holdId: scopedHoldId,
      idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Matter resolved and closed" }
    });

    const runAfterRelease = await runRetention({
      who: whoA,
      actor: actorA,
      dataCategory: "WORK_FACT",
      idempotencyKey: crypto.randomUUID(),
      now: NOW
    });
    assert.strictEqual(runAfterRelease.body.held, 0, "No records held after release");
    assert.strictEqual(factBySource("ret-old-a2"), undefined, "Previously held fact is now purged");

    await assert.rejects(() => releaseLegalHold({
      who: whoA,
      actor: actorA,
      holdId: scopedHoldId,
      idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Duplicate release attempt" }
    }), isCode("CONFLICT"));
  });

  // Test 8: Anti-resurrection guard
  await runTest("Test 8: Anti-resurrection guard rejects re-delivered purged facts as DUPLICATE", async () => {
    const res = await ingestBatch({
      who: whoA,
      actor: actorA,
      batch: {
        connectionId: connAId,
        batchId: `batch-ret-redeliver-${crypto.randomUUID()}`,
        items: [workItem("ret-old-a", 200)]
      }
    });
    assert.strictEqual(res.body.accepted, 0, "Purged record must never be accepted again");
    assert.strictEqual(res.body.duplicate, 1, "Purged record must be counted as duplicate");
    assert.strictEqual(factBySource("ret-old-a"), undefined, "Fact must not exist in ledger");
  });

  // Test 9: Storage-layer purge guard
  await runTest("Test 9: Direct SQL DELETE without tombstone or under active hold is refused", async () => {
    const recent = factBySource("ret-new-a");
    assert.ok(recent, "Recent fact must exist for storage guard check");

    // Attempt direct delete without tombstone
    await assert.rejects(() => withTenant(tenantAId, async (tx) => {
      await tx.q("DELETE FROM work_fact_revision WHERE id = $1", [recent!.id]);
    }), /without a deletion tombstone/);

    // Place new legal hold
    const hold = await placeLegalHold({
      who: whoA,
      actor: actorA,
      idempotencyKey: crypto.randomUUID(),
      input: {
        dataCategory: "WORK_FACT",
        matterRef: "MATTER-STORAGE-01",
        reason: "Test storage guard under hold"
      }
    });

    // Attempt delete even with tombstone while hold is active
    await assert.rejects(() => withTenant(tenantAId, async (tx) => {
      await tx.q(
        "INSERT INTO deletion_tombstone (id, tenant_id, run_id, data_category, record_ref, record_digest, record_key_digest) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [crypto.randomUUID(), tenantAId, crypto.randomUUID(), "WORK_FACT", recent!.id, "digest", "key-digest"]
      );
      await tx.q("DELETE FROM work_fact_revision WHERE id = $1", [recent!.id]);
    }), /under legal hold/);

    assert.ok(factBySource("ret-new-a"), "Fact must remain intact after refused delete");

    // Clean up hold
    await releaseLegalHold({
      who: whoA,
      actor: actorA,
      holdId: hold.body.id,
      idempotencyKey: crypto.randomUUID(),
      input: { releaseReason: "Clean up test hold" }
    });
  });

  console.log(`\n\x1b[32m✔ Completed Phase 5 Retention & Jurisdiction Test Suite: ${passed}/9 tests passed.\x1b[0m\n`);
}

main().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
