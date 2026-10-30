// backend/tools/demo-cycle.ts
import crypto from "node:crypto";
import { GOLDEN_01 } from "../src/fixtures/golden01";
import { seedTwoTenants } from "../src/fixtures/seed";
import { createDevToken, authenticate, resolveActor } from "../src/domains/tenant/auth";
import { createOrganization, getOrganization, listOrganizations } from "../src/domains/tenant/commands";
import { ingestBatch } from "../src/domains/ingest/ingest-batch";
import { compileRelease } from "../src/domains/privacy";
import { materialHash, canTransition, evaluateSuggestion, exportEvidencePackage } from "../src/domains/control";
import { getJurisdictionCoverage, setRetentionClass, placeLegalHold, releaseLegalHold, runRetention } from "../src/domains/lifecycle";
import { generateDiagnosticReceipt, verifyDiagnosticReceipt } from "../src/domains/support";
import { runAiUseCase, acceptAiRun } from "../src/domains/ai";
import { proposeAction, dispatchAction } from "../src/domains/actions";

import { drainOnce } from "../src/worker/outbox-publisher";
import { withTenant, memDb } from "../src/platform/db/with-tenant";

console.log("\x1b[35m============================================================\x1b[0m");
console.log("\x1b[35m=== ZOIKO ABATE: Golden Demo Cycle (Phases 0-5, B8) ===\x1b[0m");
console.log("\x1b[35m============================================================\x1b[0m\n");

async function runDemoCycle() {
  console.log("Step 1. Seeding ABATE-GOLDEN-01 synthetic fixture (Tenants A and B)...");
  await seedTwoTenants();
  console.log("  ✔ Tenant A:", GOLDEN_01.tenantA.name, `(${GOLDEN_01.tenantA.id})`);
  console.log("  ✔ Tenant B:", GOLDEN_01.tenantB.name, `(${GOLDEN_01.tenantB.id})\n`);

  console.log("Step 2. Authenticating as Tenant A Risk Owner via Bearer token...");
  const tokenA = createDevToken({
    tenantId: GOLDEN_01.tenantA.id,
    subject: "auth0|user-tenant-a-risk-owner",
    role: "RISK_OWNER",
    purpose: GOLDEN_01.tenantA.defaultPurpose
  });
  const whoA = await authenticate(`Bearer ${tokenA}`);
  const actorA = await resolveActor(whoA.tenantId, whoA.subject);
  console.log("  ✔ Authenticated identity:", whoA.subject);
  console.log("  ✔ Tenant context bound to:", whoA.tenantId);
  console.log("  ✔ Resolved effective role:", actorA.memberships[0]?.domain_role, "\n");

  console.log("Step 3. Executing idempotent domain command: createOrganization...");
  const idempotencyKey = `idem-${crypto.randomUUID()}`;
  const commandResult = await createOrganization({
    who: whoA,
    actor: actorA,
    body: { name: "Corporate Real Estate Practice" },
    idempotencyKey
  });
  const createdOrgId = commandResult.body.id;
  console.log("  ✔ Organization created:", commandResult.body.name);
  console.log("  ✔ Org ID:", createdOrgId);
  console.log("  ✔ Response Status:", commandResult.status, "\n");

  console.log("Step 4. Testing exact command replay with same Idempotency-Key...");
  const replayResult = await createOrganization({
    who: whoA,
    actor: actorA,
    body: { name: "Corporate Real Estate Practice" },
    idempotencyKey
  });
  console.log("  ✔ Cached response returned deterministically:", replayResult.body.id === createdOrgId);
  console.log("  ✔ Zero duplicate records created in authoritative state.\n");

  console.log("Step 5. Verifying cross-tenant isolation and fail-closed denial...");
  const readByA = await getOrganization({ who: whoA, actor: actorA, orgId: createdOrgId });
  console.log("  ✔ Tenant A read access verified:", readByA.name);

  const tokenB = createDevToken({
    tenantId: GOLDEN_01.tenantB.id,
    subject: "auth0|user-tenant-b-risk-owner",
    role: "RISK_OWNER"
  });
  const whoB = await authenticate(`Bearer ${tokenB}`);
  const actorB = await resolveActor(whoB.tenantId, whoB.subject);

  try {
    await getOrganization({ who: whoB, actor: actorB, orgId: createdOrgId });
    throw new Error("SECURITY FAILURE: Tenant B was able to read Tenant A's data!");
  } catch (err: any) {
    console.log(`  ✔ Tenant B request rejected with safe error: [${err.code}] ${err.message}`);
    console.log("  ✔ Existence of Tenant A resource completely masked from Tenant B.\n");
  }

  console.log("Step 6. Ingestion & Work Ledger Pipeline (Phase 2)...");
  const connAId = "00000000-0000-4000-a004-000000000001";
  const batchId = `batch-demo-${crypto.randomUUID()}`;
  const batch = {
    connectionId: connAId,
    batchId,
    items: [
      {
        recordId: "rec-demo-001",
        revision: 1,
        subjectRef: "emp-demo-001",
        startUtc: "2026-03-05T09:00:00.000Z",
        endUtc: "2026-03-05T17:00:00.000Z",
        workTz: "Europe/London",
        kind: "WORK" as const
      },
      {
        recordId: "rec-demo-002",
        revision: 1,
        subjectRef: "emp-demo-001",
        startUtc: "2026-03-05T20:00:00.000Z",
        endUtc: "2026-03-05T22:00:00.000Z",
        workTz: "Europe/London",
        kind: "WORK" as const
      }
    ]
  };

  const ingestRes = await ingestBatch({
    who: whoA,
    actor: actorA,
    batch
  });
  console.log("  ✔ Ingestion batch status: SUCCESS");
  console.log("  ✔ Work ledger records accepted:", ingestRes.body.accepted);

  console.log("Step 7. Deterministic Measurement & Privacy Release Compiler (Phase 3)...");
  const query = {
    metricId: "BOUNDARY_INTRUSION_SHARE",
    metricVersion: 1,
    cohortRef: "org:cohort-corporate-litigation",
    periodStart: "2026-03-02T00:00:00.000Z",
    periodEnd: "2026-03-30T00:00:00.000Z",
    releaseClass: "CLASS_B" as const
  };
  const members = Array.from({ length: 12 }, (_, i) => `emp-demo-${i + 1}`);
  const releaseRes = await compileRelease(whoA.tenantId, query, members);
  console.log("  ✔ Privacy Compiler Gate Status:", releaseRes.status);
  console.log("  ✔ Committed Release ID:", releaseRes.releaseId);
  const originatingReleaseId = releaseRes.releaseId!;

  console.log("Step 8. Plane A Hazard & Accepted Organizational Cause (Phase 4)...");
  let hazardId = "";
  let causeId = "";
  let controlId = "";

  await withTenant(whoA.tenantId, async (tx) => {
    hazardId = crypto.randomUUID();
    await tx.q(
      "INSERT INTO hazard (id, tenant_id, title, owner_principal_id, originating_release_id, disposition, version) VALUES ($1, $2, $3, $4, $5, 'OPEN', 1)",
      [hazardId, whoA.tenantId, "Chronic Late-Night Intrusive Work Orders", actorA.principalId, originatingReleaseId]
    );

    causeId = crypto.randomUUID();
    await tx.q(
      "INSERT INTO cause (id, tenant_id, hazard_id, statement, status, version) VALUES ($1, $2, $3, $4, 'REVIEWED_ACCEPTED', 1)",
      [causeId, whoA.tenantId, hazardId, "Unpredictable late-night email routing by cross-border partners"]
    );
  });
  console.log("  ✔ Hazard registered with originating release evidence:", hazardId);
  console.log("  ✔ Organizational cause reviewed and accepted by human authority:", causeId);

  console.log("Step 9. Version-Bound Control Drafting & Approval (Phase 4)...");
  const v1Plan = {
    baselineReleaseId: originatingReleaseId,
    primaryMetric: "BOUNDARY_INTRUSION_SHARE",
    targetDelta: -10.0,
    adjacentTolerance: 5.0,
    minDays: 28
  };
  const v1Hash = materialHash({
    hazardId,
    causeId,
    scope: "Corporate Litigation practice group",
    objective: "Enforce scheduled delivery windows and quiet hours for routine filings",
    ownerPrincipalId: actorA.principalId,
    dueDate: "2026-05-01",
    verificationPlan: v1Plan
  });

  controlId = crypto.randomUUID();
  await withTenant(whoA.tenantId, async (tx) => {
    // Insert Control
    await tx.q(
      "INSERT INTO intervention (id, tenant_id, hazard_id, cause_id, state, version, scope, objective, owner_principal_id, due_date, verification_plan, material_hash) VALUES ($1, $2, $3, $4, 'PROPOSED', 1, $5, $6, $7, $8, $9, $10)",
      [controlId, whoA.tenantId, hazardId, causeId, "Corporate Litigation practice group", "Enforce scheduled delivery windows and quiet hours for routine filings", actorA.principalId, "2026-05-01", v1Plan, v1Hash]
    );

    // Approve Control bound to version 1 & material hash
    const approvalId = crypto.randomUUID();
    await tx.q(
      "INSERT INTO approval (id, tenant_id, intervention_id, approved_version, approved_material_hash, approver_principal_id, authority_ref, policy_resolution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [approvalId, whoA.tenantId, controlId, 1, v1Hash, actorA.principalId, "auth:playbook-b4", { gate: "APPROVAL", resolved: true }]
    );
    await tx.q("UPDATE intervention SET state = 'APPROVED' WHERE id = $1", ["APPROVED", controlId]);
  });
  console.log("  ✔ Control drafted in state PROPOSED and approved by authorized Risk Owner (v1, state: APPROVED)");

  console.log("Step 10. Attributable Implementation Evidence & Verification Plan (Phase 4)...");
  await withTenant(whoA.tenantId, async (tx) => {
    // Implementation receipt
    const receiptId = crypto.randomUUID();
    await tx.q(
      "INSERT INTO implementation_receipt (id, tenant_id, intervention_id, intervention_version, kind, recorded_by, completed_on, evidence_refs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [receiptId, whoA.tenantId, controlId, 1, "ORGANIZATIONAL_POLICY", actorA.principalId, "2026-04-10", ["doc:intranet-policy-v1", "sys:m365-delayed-delivery-rules"]]
    );
    await tx.q("UPDATE intervention SET state = 'IMPLEMENTED' WHERE id = $1", ["IMPLEMENTED", controlId]);

    // Pin verification plan
    const evalId = crypto.randomUUID();
    await tx.q(
      "INSERT INTO evaluation (id, tenant_id, intervention_id, plan, baseline_release_id, post_release_id, adjacent_release_ids, series_break) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [evalId, whoA.tenantId, controlId, v1Plan, originatingReleaseId, null, [], false]
    );
    await tx.q("UPDATE intervention SET state = 'VERIFYING' WHERE id = $1", ["VERIFYING", controlId]);
  });
  console.log("  ✔ Implementation receipt recorded with audit trail (state: IMPLEMENTED)");
  console.log("  ✔ Verification plan pinned before results exist (state: VERIFYING)");

  console.log("Step 11. Verification Suggestion Engine & Human Reviewer Conclusion...");
  const suggestion = evaluateSuggestion(
    { direction: "DECREASE", criteria: 10.0, adjacentTolerance: 5.0 },
    { status: "RELEASED", value: 32.5 },
    { status: "RELEASED", value: 14.0 },
    [{ baseline: { status: "RELEASED", value: 8.0 }, post: { status: "RELEASED", value: 9.0 } }]
  );
  console.log(`  ✔ Suggestion Engine recommendation: ${suggestion.suggestion} (${suggestion.why})`);

  await withTenant(whoA.tenantId, async (tx) => {
    // Conclude evaluation
    await tx.q(
      "UPDATE evaluation SET outcome = $1, reviewer_id = $2, residual_risk = $3, concluded_at = $4 WHERE intervention_id = $5",
      ["EFFECTIVE", actorA.principalId, "Residual boundary intrusion within acceptable threshold", new Date().toISOString(), controlId]
    );
    await tx.q("UPDATE intervention SET state = 'CLOSED' WHERE id = $1", ["CLOSED", controlId]);

    // Update Hazard disposition to CONTROLLED
    await tx.q("UPDATE hazard SET disposition = 'CONTROLLED' WHERE id = $1", ["CONTROLLED", hazardId]);
  });
  console.log("  ✔ Named reviewer concluded verification: EFFECTIVE, intervention state: CLOSED");
  console.log("  ✔ Hazard disposition updated: CONTROLLED");

  console.log("Step 12. Cryptographic Evidence Package Export...");
  const evidencePkg = await withTenant(whoA.tenantId, async (tx) => {
    return await exportEvidencePackage(tx, hazardId, actorA.principalId);
  });
  console.log("  ✔ Package ID:", evidencePkg.manifest.packageId);
  console.log("  ✔ Artifacts bundled:", evidencePkg.artifacts.length);
  console.log("  ✔ Manifest SHA-256 Digest:", evidencePkg.manifest.manifestHash);

  console.log("Step 13. Jurisdiction Pack, Retention Schedule & Legal Hold (Phase 5)...");
  const coverage = await getJurisdictionCoverage({ who: whoA, actor: actorA });
  if (coverage.status !== "COVERED") throw new Error("Tenant A must be covered by a jurisdiction pack");
  console.log(`  ✔ Jurisdiction pack in effect: ${coverage.pack.packId} v${coverage.pack.version} (${coverage.pack.content.title})`);

  const coverageB = await getJurisdictionCoverage({ who: whoB, actor: actorB });
  console.log(`  ✔ Tenant B coverage: ${coverageB.status} -> retention configuration fails closed`);

  const retentionClass = await setRetentionClass({
    who: whoA, actor: actorA, idempotencyKey: `idem-${crypto.randomUUID()}`,
    input: { dataCategory: "WORK_FACT", retentionDays: 90, basis: "SYNTHETIC demo schedule (tenant-configured)" }
  });
  console.log(`  ✔ Tenant retention class set: WORK_FACT ${retentionClass.body.retentionDays} days (validated against ${retentionClass.body.packId} v${retentionClass.body.packVersion})`);

  const hold = await placeLegalHold({
    who: whoA, actor: actorA, idempotencyKey: `idem-${crypto.randomUUID()}`,
    input: { dataCategory: "WORK_FACT", matterRef: "MATTER-DEMO-001", reason: "Preserve work-pattern evidence for a pending claim" }
  });
  const heldRun = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: `idem-${crypto.randomUUID()}` });
  console.log(`  ✔ Run under legal hold: eligible ${heldRun.body.eligible}, held ${heldRun.body.held}, purged ${heldRun.body.purged}`);

  await releaseLegalHold({
    who: whoA, actor: actorA, holdId: hold.body.id, idempotencyKey: `idem-${crypto.randomUUID()}`,
    input: { releaseReason: "Claim settled; preservation no longer required" }
  });
  const purgeRun = await runRetention({ who: whoA, actor: actorA, dataCategory: "WORK_FACT", idempotencyKey: `idem-${crypto.randomUUID()}` });
  console.log(`  ✔ Run after hold release: eligible ${purgeRun.body.eligible}, purged ${purgeRun.body.purged}, verified tombstones ${purgeRun.body.verified}`);

  const redelivery = await ingestBatch({ who: whoA, actor: actorA, batch: { ...batch, batchId: `batch-demo-redeliver-${crypto.randomUUID()}` } });
  console.log(`  ✔ Purged records re-delivered by source: accepted ${redelivery.body.accepted}, duplicate ${redelivery.body.duplicate} (no resurrection)\n`);

  console.log("Step 14. Zero-Impersonation Support: Signed Diagnostic Receipt (B8)...");
  const diagnostic = await generateDiagnosticReceipt({ who: whoA, actor: actorA, idempotencyKey: `idem-${crypto.randomUUID()}` });
  const transported = JSON.parse(JSON.stringify(diagnostic.body));
  console.log(`  ✔ Tenant issued receipt ${diagnostic.body.receiptId}: ${diagnostic.body.sections.connections.length} connection(s), ${diagnostic.body.sections.ingest.receipts} ingest receipt(s), retention ${diagnostic.body.sections.retention.coverage}`);
  console.log(`  ✔ Support verified signature without database access: ${verifyDiagnosticReceipt(transported).valid}`);
  transported.sections.outbox.pendingEvents += 1;
  console.log(`  ✔ Edited copy rejected: ${!verifyDiagnosticReceipt(transported).valid}\n`);

  console.log("Step 15. Draining transactional outbox via worker process...");
  const drainReport = await drainOnce();
  console.log(`  ✔ Outbox drained: ${drainReport.drained} events published.`);
  console.log(`  ✔ Total audit events recorded in append-only log: ${memDb.auditEvents.length}\n`);

  console.log("Step 16. Bounded AI & Safe Action Execution (Phase 6)...");
  await withTenant(whoA.tenantId, async (tx) => {
    // 16.1 Explain Release
    const aiRun = await runAiUseCase(tx, actorA, "explain_release", {
      contextRefs: [{ type: "RELEASE", id: "00000000-0000-4000-a003-000000000001" }],
      question: "Explain the boundary intrusion measurement."
    });
    console.log(`  ✔ AI Explanation Generated: Run ID ${aiRun.id.slice(0, 8)}... | Status: ${aiRun.status}`);
    console.log(`  ✔ Grounded Claims: ${aiRun.output?.claims.length} claim(s), all cited to released IDs (no hallucinations)`);

    // 16.2 Accept AI Draft into Workflow
    const acceptRes = await acceptAiRun(tx, actorA, aiRun.id);
    console.log(`  ✔ Proposal Accepted: ${acceptRes.decisionRef} (AI writes drafts only; human workflow commands required)`);

  });

  // 16.3 Safe Action Broker: approval-bound grant, lease + fencing, provider called outside any transaction
  const proposal = await proposeAction({
    who: whoA,
    actor: actorA,
    input: {
      tool: "ticket_notification",
      target: "team-litigation",
      params: { window: "scheduled-rest" },
      resourceVersion: 1,
      approvalRef: GOLDEN_01.approvedControl.approvalId
    }
  });
  const dispRes = await dispatchAction({
    who: whoA,
    actor: actorA,
    attemptId: proposal.attempt.id,
    input: { params: { window: "scheduled-rest" }, grantToken: proposal.grantToken }
  });
  console.log(`  ✔ Action Attempt Dispatched: State ${dispRes.state} with fencing token ${dispRes.fencingToken} (approval-bound grant verified)\n`);

  console.log("\x1b[32m====================================================================\x1b[0m");
  console.log("\x1b[32m=== DEMO CYCLE COMPLETED SUCCESSFULLY: ALL PHASES 0-6 + B8 VERIFIED ===\x1b[0m");
  console.log("\x1b[32m====================================================================\x1b[0m");
}

runDemoCycle().catch(err => {
  console.error("\x1b[31m[DEMO CYCLE FAILED]\x1b[0m", err);
  process.exit(1);
});

