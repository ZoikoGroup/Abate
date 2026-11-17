// tests/e2e/all-tabs-buttons.spec.ts
// Comprehensive per-tab interactive button and real HTTP verification suite.
// Verifies every tab, button, form, and link across the entire Abate frontend.

import { test, expect, type Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
const TENANT_B_ID = "00000000-0000-4000-b000-00000000000b";

async function openTab(page: Page, tabName: string) {
  await page.goto(BASE_URL);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });
  const navBtn = page.locator("nav.tabs-navigation").getByRole("button", { name: tabName, exact: true });
  await navBtn.click();
}

test.describe("All Tabs & Buttons Full Real Verification", () => {
  test.beforeEach(async ({ page }) => {
    page.on("dialog", async (dialog) => {
      throw new Error(`Unexpected browser dialog (${dialog.type()}): ${dialog.message()}`);
    });
  });

  test("Navbar: tenant switch, role switch, refresh, live demo toggle & dev mode session", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // Switch Role
    const roleSelect = page.getByLabel(/Effective Domain Role:/i);
    await roleSelect.selectOption("REVIEWER");
    await expect(roleSelect).toHaveValue("REVIEWER");
    await roleSelect.selectOption("RISK_OWNER");

    // Switch Tenant
    const tenantSelect = page.getByLabel(/Active Tenant Scope:/i);
    const tenantBRes = page.waitForResponse(r => r.url().includes("/api/v2/auth/token") && r.request().method() === "POST");
    await tenantSelect.selectOption(TENANT_B_ID);
    expect((await tenantBRes).status()).toBe(200);
    await expect(page.getByText(/Active Tenant Organizations \(Beacon Chambers/i)).toBeVisible({ timeout: 10_000 });

    // Refresh
    const refreshRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "GET");
    await page.getByRole("button", { name: "Refresh live data" }).click();
    expect((await refreshRes).status()).toBe(200);

    // Launch Live Demo Console & return
    await page.getByRole("button", { name: /Launch Guided Live Demo Console/i }).click();
    await expect(page.getByRole("heading", { name: /Live Demo Console/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /Back to App/i }).click();
    await expect(page.locator("nav.tabs-navigation")).toBeVisible({ timeout: 10_000 });
  });

  test("Organizations & Idempotency tab: every button & error path works cleanly", async ({ page }) => {
    await openTab(page, "Organizations & Idempotency");
    const uniqueName = `Chambers Unit ${Date.now()}`;

    await page.getByRole("button", { name: /Generate New Key/i }).click();
    await page.getByLabel(/Organization \/ Practice Name/i).fill(uniqueName);

    const createRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Create Organization via runCommand/i }).click();
    expect([200, 201]).toContain((await createRes).status());
    await expect(page.getByText("COMMAND COMPLETED (SUCCESS)")).toBeVisible();
    await expect(page.locator("table").getByText(uniqueName)).toHaveCount(1);

    const replayRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Replay Exact Same Request/i }).click();
    expect((await replayRes).status()).toBe(200);
    await expect(page.locator("table").getByText(uniqueName)).toHaveCount(1);

    const conflictRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Tamper Payload with Same Key/i }).click();
    expect((await conflictRes).status()).toBe(409);
    await expect(page.getByText(/409 CONFLICT: Idempotency Key collision/i)).toBeVisible();
    await expect(page.getByText(/Request ID:/i)).toBeVisible();

    await page.getByLabel(/Inject prohibited field/i).check();
    await page.getByLabel(/Organization \/ Practice Name/i).fill("Surveillance Probe Org");
    const decoyRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Create Organization via runCommand/i }).click();
    expect((await decoyRes).status()).toBe(400);
    await expect(page.getByText(/CONSTITUTIONAL BOUNDARY DEFENDED/i)).toBeVisible();
  });

  test("Ingestion & Work Ledger (Phase 2) tab: every batch, decoy, revision & connection control works", async ({ page }) => {
    await openTab(page, "Ingestion & Work Ledger (Phase 2)");
    await expect(page.getByRole("heading", { name: /Ingestion & Work-State Ledger/i })).toBeVisible();

    const cleanRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Send Clean Batch/i }).click();
    expect((await cleanRes).status()).toBe(200);
    await expect(page.getByText(/Standard Batch Ingested Successfully/i)).toBeVisible();
    await expect(page.getByText(/Batch "undefined"/i)).toHaveCount(0);

    const dupRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Send Duplicate Replay/i }).click();
    expect((await dupRes).status()).toBe(200);
    await expect(page.getByText(/Duplicate Batch Handled Idempotently/i)).toBeVisible();

    const decoyRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Send Surveillance Decoy/i }).click();
    expect((await decoyRes).status()).toBe(400);
    await expect(page.getByText(/Physical Minimization Confirmed/i)).toBeVisible();

    const revRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Send Revision 2/i }).click();
    expect((await revRes).status()).toBe(200);
    await expect(page.getByText(/Revision 2 Appended to Ledger/i)).toBeVisible();

    const regRes = page.waitForResponse(r => r.url().includes("/api/v2/connections") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Register Connection/i }).click();
    expect([200, 201]).toContain((await regRes).status());
    await expect(page.getByText(/Source Connection Registered/i)).toBeVisible();

    const pauseRes = page.waitForResponse(r => r.url().includes("/pause") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Pause", exact: true }).last().click();
    expect((await pauseRes).status()).toBe(200);
    await expect(page.getByText(/Connection PAUSED/i)).toBeVisible();

    const resumeRes = page.waitForResponse(r => r.url().includes("/resume") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Resume", exact: true }).last().click();
    expect((await resumeRes).status()).toBe(200);
    await expect(page.getByText(/Connection RESUMED/i)).toBeVisible();

    const revokeRes = page.waitForResponse(r => r.url().includes("/revoke") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Revoke", exact: true }).last().click();
    expect((await revokeRes).status()).toBe(200);
    await expect(page.getByText(/Connection REVOKED/i)).toBeVisible();
  });

  test("Cohort Analytics & Privacy (Phase 3) tab: every reconstruction attack, query, CSV & recalc works", async ({ page }) => {
    await openTab(page, "Cohort Analytics & Privacy (Phase 3)");
    await expect(page.getByRole("heading", { name: /Deterministic Cohort Measurement/i })).toBeVisible();

    // 1. n=9 suppressed
    const r9 = page.waitForResponse(r => r.url().includes("/api/v2/releases/query") && r.request().method() === "POST");
    await page.getByRole("button", { name: /1\. Test n = 9 Floor Violation/i }).click();
    expect((await r9).status()).toBe(200);
    await expect(page.getByText(/RELEASE SUPPRESSED/i)).toBeVisible();

    // 2. n=10 released
    const r10 = page.waitForResponse(r => r.url().includes("/api/v2/releases/query") && r.request().method() === "POST");
    await page.getByRole("button", { name: /2\. Test n = 10 Valid Release/i }).click();
    expect((await r10).status()).toBe(200);
    await expect(page.getByText(/PRIVACY COMPILER RELEASE APPROVED/i)).toBeVisible();

    // 3. Overlap differencing suppressed
    await page.getByRole("button", { name: /3\. Overlap Differencing Attack/i }).click();
    await expect(page.getByText(/RELEASE SUPPRESSED/i)).toBeVisible();

    // 4. Residual differencing suppressed
    await page.getByRole("button", { name: /4\. Parent\/Child Residual Attack/i }).click();
    await expect(page.getByText(/RELEASE SUPPRESSED/i)).toBeVisible();

    // Semantic query
    const qRes = page.waitForResponse(r => r.url().includes("/api/v2/releases/query") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Execute Semantic Query/i }).click();
    expect((await qRes).status()).toBe(200);
    await expect(page.getByText(/PRIVACY COMPILER RELEASE APPROVED/i)).toBeVisible();

    // CSV export (needs RELEASED releaseId active)
    const csvRes = page.waitForResponse(r => r.url().includes("/export.csv") && r.request().method() === "GET");
    await page.getByRole("button", { name: /Export Release CSV/i }).click();
    expect((await csvRes).status()).toBe(200);
    await expect(page.getByText(/RELEASE CSV EXPORTED/i)).toBeVisible();

    // Recalculate
    const recalcRes = page.waitForResponse(r => r.url().includes("/recalculate") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Trigger Recalculation/i }).click();
    expect((await recalcRes).status()).toBe(200);
    await expect(page.getByText(/METRIC RECALCULATION TRIGGERED/i)).toBeVisible();
  });

  test("Hazards & Controls (Phase 4) tab: full lifecycle, refusal gates, AI panel & evidence export work", async ({ page }) => {
    await openTab(page, "Hazards & Controls (Phase 4)");
    await expect(page.getByRole("heading", { name: /Hazard Workspace/i })).toBeVisible();

    // Select a Legal Matter via interactive button
    const matterBtns = page.locator("button").filter({ hasText: /MA-2026|LIT-|REG-|ARB-/ });
    if ((await matterBtns.count()) > 0) {
      const fatRes = page.waitForResponse(r => r.url().includes("/api/v2/sector/legal/fatigue-check"));
      await matterBtns.first().click();
      expect((await fatRes).status()).toBe(200);
    }

    // Create new hazard
    await page.getByRole("button", { name: /Use Seeded Baseline/i }).click();
    const createH = page.waitForResponse(r => r.url().endsWith("/api/v2/hazards") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Register Authoritative Hazard/i }).click();
    expect([200, 201]).toContain((await createH).status());
    await expect(page.getByText(/HAZARD REGISTERED IN AUTHORITATIVE STATE/i)).toBeVisible();

    // AiPanel inside Hazard Workspace
    const explainRes = page.waitForResponse(r => r.url().includes("/api/v2/ai/explain-release") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Generate AI Explanation/i }).click();
    expect((await explainRes).status()).toBe(200);
    const discardBtn = page.getByRole("button", { name: /Discard/i }).first();
    if (await discardBtn.isVisible()) {
      await discardBtn.click();
      await expect(page.getByText(/AI proposal discarded/i)).toBeVisible();
    }

    // Propose & accept cause
    const causeRes = page.waitForResponse(r => r.url().includes("/causes") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Propose Cause", exact: true }).click();
    expect([200, 201]).toContain((await causeRes).status());
    await expect(page.getByText(/ORGANIZATIONAL CAUSE PROPOSED/i)).toBeVisible();

    const acceptBtn = page.getByRole("button", { name: /Accept Cause/i }).first();
    const reviewRes = page.waitForResponse(r => r.url().includes("/review") && r.request().method() === "POST");
    await acceptBtn.click();
    expect((await reviewRes).status()).toBe(200);
    await expect(page.getByText(/CAUSE STATUS UPDATED: REVIEWED_ACCEPTED/i)).toBeVisible();

    // Draft Control
    const ctrlRes = page.waitForResponse(r => r.url().endsWith("/api/v2/controls") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Commit Control Draft on Accepted Cause/i }).first().click();
    expect([200, 201]).toContain((await ctrlRes).status());
    await expect(page.getByText(/CONTROL DRAFT CREATED/i)).toBeVisible();

    // Adversarial Gate 1 (real 409 skip approval attack)
    const gate1Res = page.waitForResponse(r => r.url().includes("/implementation") && r.request().method() === "POST");
    await page.getByRole("button", { name: /1\. Skip Approval Attack/i }).click();
    expect((await gate1Res).status()).toBe(409);
    await expect(page.getByText(/REFUSAL GATE 1: PROPOSED -> IMPLEMENTING BLOCKED/i)).toBeVisible();

    // Adversarial Gate 2 (real 409 stale version)
    const gate2Res = page.waitForResponse(r => r.url().includes("/approve") && r.request().method() === "POST");
    await page.getByRole("button", { name: /2\. .*v4 Cannot Approve v5/i }).click();
    expect((await gate2Res).status()).toBe(409);
    await expect(page.getByText(/REFUSAL GATE 2: STALE VERSION REJECTED/i)).toBeVisible();

    // Adversarial Gate 3 (Simulation)
    await page.getByRole("button", { name: /3\. Transfer of Risk Flag/i }).click();
    await expect(page.getByText(/SIMULATION — REFUSAL GATE 3/i)).toBeVisible();

    // Approve -> Material Edit -> Re-approve -> Implement -> Pin Verification -> Conclude
    const approve1 = page.waitForResponse(r => r.url().includes("/approve") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Approve Control/i }).click();
    expect((await approve1).status()).toBe(200);

    await page.getByLabel(/Updated intervention scope/i).fill("Updated Scope With Rest Buffers");
    const editRes = page.waitForResponse(r => r.url().includes("/api/v2/controls/") && r.request().method() === "PATCH");
    await page.getByRole("button", { name: /Apply Material Edit/i }).click();
    expect((await editRes).status()).toBe(200);
    await expect(page.getByText(/APPROVAL RESET/i)).toBeVisible();

    const approve2 = page.waitForResponse(r => r.url().includes("/approve") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Approve Control/i }).click();
    expect((await approve2).status()).toBe(200);

    const implRes = page.waitForResponse(r => r.url().includes("/implementation") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Commit Implementation Receipt/i }).click();
    expect((await implRes).status()).toBe(201);
    await expect(page.getByText(/IMPLEMENTATION RECEIPT RECORDED/i)).toBeVisible();

    const pinRes = page.waitForResponse(r => r.url().includes("/verification/pin") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Pin Verification Plan/i }).click();
    expect([200, 201]).toContain((await pinRes).status());
    await expect(page.getByText(/VERIFICATION PLAN PINNED/i)).toBeVisible();

    const conclRes = page.waitForResponse(r => r.url().includes("/verification/conclude") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Commit Reviewer Conclusion/i }).click();
    expect((await conclRes).status()).toBe(200);
    await expect(page.getByText(/VERIFICATION CONCLUDED/i)).toBeVisible();

    // Set Hazard Disposition & Export Evidence Package
    const dispRes = page.waitForResponse(r => r.url().includes("/disposition") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Commit Hazard Disposition/i }).click();
    expect((await dispRes).status()).toBe(200);
    await expect(page.getByText(/HAZARD DISPOSITION UPDATED/i)).toBeVisible();

    const pkgRes = page.waitForResponse(r => r.url().includes("/evidence-package") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Export Evidence Package/i }).click();
    expect([200, 201]).toContain((await pkgRes).status());
    await expect(page.getByText(/CRYPTOGRAPHIC EVIDENCE PACKAGE EXPORTED/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Download JSON/i })).toBeEnabled();
  });

  test("Retention & Legal Hold (Phase 5) tab: class, holds, seed facts, preview & run work", async ({ page }) => {
    await openTab(page, "Retention & Legal Hold (Phase 5)");
    await expect(page.getByRole("heading", { name: /Jurisdiction Pack in Effect/i })).toBeVisible();

    await page.getByLabel(/Basis \/ citation/i).fill("Records policy RP-7 section 3");
    const classRes = page.waitForResponse(r => r.url().includes("/api/v2/retention/classes") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Save retention class/i }).click();
    expect([200, 201]).toContain((await classRes).status());
    await expect(page.getByText(/Retention class saved/i)).toBeVisible();

    await page.getByLabel(/Matter reference/i).fill("MATTER-E2E-2026");
    await page.getByLabel(/Reason/i).fill("Statutory litigation preservation hold");
    const holdRes = page.waitForResponse(r => r.url().includes("/legal-holds") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Place legal hold/i }).click();
    expect([200, 201]).toContain((await holdRes).status());
    await expect(page.getByText(/Legal hold placed/i)).toBeVisible();

    await page.getByLabel(/Release reason for MATTER-E2E-2026/i).fill("Matter concluded and cleared");
    const relRes = page.waitForResponse(r => r.url().includes("/release") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Release", exact: true }).first().click();
    expect((await relRes).status()).toBe(200);
    await expect(page.getByText(/Legal hold released/i)).toBeVisible();

    const seedRes = page.waitForResponse(r => r.url().includes("/zoikotime/batches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Ingest sample expired facts/i }).click();
    expect((await seedRes).status()).toBe(200);
    await expect(page.getByText(/Sample facts ingested/i)).toBeVisible();

    const prevRes = page.waitForResponse(r => r.url().includes("/api/v2/retention/preview") && r.request().method() === "GET");
    await page.getByRole("button", { name: /Preview \(dry run\)/i }).click();
    expect((await prevRes).status()).toBe(200);
    await expect(page.getByText(/Preview computed/i)).toBeVisible();

    const runRes = page.waitForResponse(r => r.url().includes("/api/v2/retention/runs") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Run retention now/i }).click();
    expect([200, 201]).toContain((await runRes).status());
    await expect(page.getByText(/Retention run recorded/i)).toBeVisible();
  });

  test("Bounded AI & Actions (Phase 6) tab: all 6 labs, AI panel & kill switches work", async ({ page }) => {
    await openTab(page, "Bounded AI & Actions (Phase 6)");
    await expect(page.getByRole("heading", { name: /Bounded AI & Safe Action Execution/i })).toBeVisible();

    // Lab 1-3
    await page.getByRole("button", { name: /1\. Test Prompt Injection/i }).click();
    await expect(page.getByText(/LAB 1 PASSED/i)).toBeVisible();

    await page.getByRole("button", { name: /2\. Test Citation Fabrication/i }).click();
    await expect(page.getByText(/LAB 2 PASSED/i)).toBeVisible();

    await page.getByRole("button", { name: /3\. Test Numeric Tampering/i }).click();
    await expect(page.getByText(/LAB 3 PASSED/i)).toBeVisible();

    // Lab 4
    const indRes = page.waitForResponse(r => r.url().includes("/api/v2/ai/explain-release"));
    await page.getByRole("button", { name: /4\. Test Individual Inference/i }).click();
    expect([400, 403]).toContain((await indRes).status());
    await expect(page.getByText(/LAB 4 PASSED/i)).toBeVisible();

    // Lab 5
    const disp5 = page.waitForResponse(r => r.url().includes("/dispatch") && r.request().method() === "POST");
    await page.getByRole("button", { name: /5\. Test Parameter Mutation/i }).click();
    expect([400, 403, 409]).toContain((await disp5).status());
    await expect(page.getByText(/LAB 5 PASSED/i)).toBeVisible();

    // Lab 6
    const disp6 = page.waitForResponse(r => r.url().includes("/dispatch") && r.request().method() === "POST");
    await page.getByRole("button", { name: /6\. Test Timeout Reconciliation/i }).click();
    expect((await disp6).status()).toBe(200);
    await expect(page.getByText(/LAB 6 PASSED/i)).toBeVisible();

    // Live AiPanel explanation & accept
    const expRes = page.waitForResponse(r => r.url().includes("/api/v2/ai/explain-release") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Generate AI Explanation/i }).click();
    expect((await expRes).status()).toBe(200);
    const acceptProposal = page.getByRole("button", { name: /Accept as Draft Proposal/i });
    if (await acceptProposal.isVisible()) {
      const accRes = page.waitForResponse(r => r.url().includes("/accept"));
      await acceptProposal.click();
      expect((await accRes).status()).toBe(200);
      await expect(page.getByText(/AI DRAFT COMMITTED TO WORKFLOW/i)).toBeVisible();
    }

    // Kill switch toggle & restore back to ONLINE
    const killBtn = page.getByRole("button", { name: /Kill \/ Disable Immediately/i }).first();
    const ksRes = page.waitForResponse(r => r.url().includes("/api/v2/ops/kill-switches") && r.request().method() === "POST");
    await killBtn.click();
    expect((await ksRes).status()).toBe(200);
    await expect(page.getByText(/KILL SWITCH ACTIVATED/i)).toBeVisible();

    const reEnableBtn = page.getByRole("button", { name: /Re-enable Service/i }).first();
    const ksRestore = page.waitForResponse(r => r.url().includes("/api/v2/ops/kill-switches") && r.request().method() === "POST");
    await reEnableBtn.click();
    expect((await ksRestore).status()).toBe(200);
    await expect(page.getByText(/KILL SWITCH DEACTIVATED/i)).toBeVisible();
  });

  test("Outcomes & AI Change (Phase 7) tab: Plane B toggle, prohibited claim, evaluation & AI change work", async ({ page }) => {
    await openTab(page, "Outcomes & AI Change (Phase 7)");
    await expect(page.getByRole("heading", { name: /Work-Design Outcomes & Governed AI Change/i })).toBeVisible();

    // Refresh
    const refRes = page.waitForResponse(r => r.url().includes("/api/v2/outcomes/definitions"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    expect((await refRes).status()).toBe(200);

    // Ensure Plane B flag enabled
    const enableBtn = page.getByRole("button", { name: /Enable Plane B Now|DISABLED/i }).first();
    if (await enableBtn.isVisible()) {
      const flagRes = page.waitForResponse(r => r.url().includes("/api/v2/flags") && r.request().method() === "POST");
      await enableBtn.click();
      expect((await flagRes).status()).toBe(200);
      await expect(page.getByText(/Feature Flag 'outcomes_plane_b' ENABLED/i)).toBeVisible();
    }

    // 1. Prohibited Claim Injection (real 400 VALIDATION, not 404!)
    const prohRes = page.waitForResponse(r => r.url().includes("/api/v2/outcomes/evaluations") && r.request().method() === "POST");
    await page.getByRole("button", { name: /1\. Prohibited Claim Injection/i }).click();
    expect((await prohRes).status()).toBe(400);
    await expect(page.getByText(/LAB 2 PASSED: PROHIBITED CLAIM REJECTED \(HTTP 400 FAIL-CLOSED\)/i)).toBeVisible();

    // Record valid Plane B evaluation
    const evalRes = page.waitForResponse(r => r.url().includes("/api/v2/outcomes/evaluations") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Record Evaluation \(Plane B\)/i }).click();
    expect((await evalRes).status()).toBe(201);
    await expect(page.getByText(/PLANE B OUTCOME EVALUATION RECORDED/i)).toBeVisible();

    // Register AI Profile
    const regAi = page.waitForResponse(r => r.url().endsWith("/api/v2/ai-changes") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Register AI Profile/i }).click();
    expect((await regAi).status()).toBe(201);
    await expect(page.getByText(/AI CHANGE PROFILE & ASSESSMENT REGISTERED/i)).toBeVisible();

    // 2. Premature AI Closure Attack (real 409 CONFLICT stage guard)
    const premRes = page.waitForResponse(r => r.url().includes("/advance") && r.request().method() === "POST");
    await page.getByRole("button", { name: /2\. Premature AI Closure Attack/i }).click();
    expect((await premRes).status()).toBe(409);
    await expect(page.getByText(/LAB 5 PASSED: STAGE GUARD INTEGRITY ENFORCED/i)).toBeVisible();

    // Advance Stage -> BASELINE
    const advRes = page.waitForResponse(r => r.url().includes("/advance") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Advance to BASELINE/i }).click();
    expect((await advRes).status()).toBe(200);
    await expect(page.getByText(/STAGE ADVANCED TO BASELINE/i)).toBeVisible();
  });

  test("Legal Sector Pack (SRA 2023) tab: filter, refresh, fatigue check, Simulation sign & boundary gate", async ({ page }) => {
    await openTab(page, "Legal Sector Pack (SRA 2023)");
    await expect(page.getByRole("heading", { name: /UK Legal Practice & Workplace Culture/i })).toBeVisible();

    await page.getByLabel(/Filter Practice Area/i).selectOption("COMMERCIAL_LITIGATION");
    await page.getByLabel(/Filter Practice Area/i).selectOption("ALL");

    const refRes = page.waitForResponse(r => r.url().includes("/api/v2/sector/legal/matters"));
    await page.locator("#legal-practice-tab").getByRole("button", { name: /Refresh/i }).click();
    expect((await refRes).status()).toBe(200);

    const fatRes = page.waitForResponse(r => r.url().includes("/api/v2/sector/legal/fatigue-check"));
    await page.getByRole("button", { name: /SRA Fatigue Check/i }).first().click();
    expect((await fatRes).status()).toBe(200);

    const signBtn = page.getByRole("button", { name: /Sign Supervisory Consultation Gate \(Simulation\)/i });
    if (await signBtn.isVisible()) {
      await signBtn.click();
      await expect(page.getByText(/Simulation: Client-side Supervisory Partner consultation preview signed/i)).toBeVisible();
    }

    // Decoy blocked with 400
    await page.getByLabel(/Inject Privileged Legal Advice/i).check();
    const mapDecoy = page.waitForResponse(r => r.url().includes("/api/v2/sector/legal/matters/map"));
    await page.getByRole("button", { name: /Execute Translation & Boundary Gate/i }).click();
    expect((await mapDecoy).status()).toBe(400);
    await expect(page.getByText(/Constitutional Boundary Defended/i)).toBeVisible();

    // Clean map succeeds 200
    await page.getByLabel(/Inject Privileged Legal Advice/i).uncheck();
    const mapClean = page.waitForResponse(r => r.url().includes("/api/v2/sector/legal/matters/map"));
    await page.getByRole("button", { name: /Execute Translation & Boundary Gate/i }).click();
    expect((await mapClean).status()).toBe(200);
    await expect(page.getByText(/Mapped Neutral Representation/i)).toBeVisible();
  });

  test("Operations & Support (B8) tab: receipts, support login, SLOs, dossier gates & simulation labels work", async ({ page }) => {
    await openTab(page, "Operations & Support (B8)");
    await expect(page.getByRole("heading", { name: /Tenant: Diagnostic Receipt for Support/i })).toBeVisible();

    const recRes = page.waitForResponse(r => r.url().includes("/api/v2/support/diagnostic-receipts") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Issue diagnostic receipt/i }).click();
    expect([200, 201]).toContain((await recRes).status());
    await expect(page.getByText(/Diagnostic receipt issued/i)).toBeVisible();

    const supRes = page.waitForResponse(r => r.url().includes("/api/v2/auth/support-token") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Sign in as support operator/i }).click();
    expect((await supRes).status()).toBe(200);
    await expect(page.getByText(/Support session started/i)).toBeVisible();

    await expect(page.getByText(/Simulation \(Reference Target\)/i)).toBeVisible();
    await expect(page.getByText(/Simulation \(Baseline Reference\)/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Release Evidence Dossier Gates/i })).toBeVisible();

    const refRes = page.waitForResponse(r => r.url().includes("/api/v2/ops/slo"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    expect((await refRes).status()).toBe(200);

    const verRes = page.waitForResponse(r => r.url().includes("/api/v2/ops/diagnostic-receipts/verify") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Verify signature/i }).click();
    expect((await verRes).status()).toBe(200);
    await expect(page.getByText(/Receipt checked/i)).toBeVisible();

    // Kill switch toggle & restore
    const ksOn = page.waitForResponse(r => r.url().includes("/api/v2/ops/kill-switches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Activate Kill Switch/i }).first().click();
    expect((await ksOn).status()).toBe(200);
    const ksOff = page.waitForResponse(r => r.url().includes("/api/v2/ops/kill-switches") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Deactivate \(Re-enable\)/i }).first().click();
    expect((await ksOff).status()).toBe(200);
  });

  test("Tenant Isolation & Attack Lab tab: Simulates cross-tenant read and asserts 404 NOT_FOUND", async ({ page }) => {
    await openTab(page, "Tenant Isolation & Attack Lab");
    await expect(page.getByRole("heading", { name: /Tenant Isolation & Security Boundary/i })).toBeVisible();

    const atkRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations/") && r.request().method() === "GET");
    await page.getByRole("button", { name: /Simulate Cross-Tenant Read/i }).click();
    expect((await atkRes).status()).toBe(404);
    await expect(page.getByText(/ATTACK BLOCKED & SAFE 404 RETURNED \(PASS\)/i)).toBeVisible();
  });

  test("Transactional Outbox tab: Trigger Worker Drain Loop succeeds with inline banner", async ({ page }) => {
    await openTab(page, "Transactional Outbox");
    await expect(page.getByRole("heading", { name: /Transactional Outbox & Worker Pipeline/i })).toBeVisible();

    const drainRes = page.waitForResponse(r => r.url().includes("/api/v2/outbox/drain") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Trigger Worker Drain Loop/i }).click();
    expect((await drainRes).status()).toBe(200);
    await expect(page.getByText(/DRAIN LOOP EXECUTED/i)).toBeVisible();
  });

  test("Append-Only Audit Trail tab: Refresh Log reloads tenant audit events", async ({ page }) => {
    await openTab(page, "Append-Only Audit Trail");
    await expect(page.getByRole("heading", { name: /Append-Only Audit Trail/i })).toBeVisible();

    const auditRes = page.waitForResponse(r => r.url().includes("/api/v2/audit-events") && r.request().method() === "GET");
    await page.getByRole("button", { name: /Refresh Log/i }).click();
    expect((await auditRes).status()).toBe(200);
    await expect(page.getByText(/Refreshed .* audit log/i)).toBeVisible();
  });

  test("Audit Verifier & Merkle tab: Sample, Tamper, Re-Verify, Merkle Leaf & Live Backend Package work", async ({ page }) => {
    await openTab(page, "Audit Verifier & Merkle");
    await expect(page.getByRole("heading", { name: /Cryptographic Evidence Verifier/i })).toBeVisible();
    await expect(page.getByText(/VERIFIED: Manifest Hash/i)).toBeVisible();

    const issueRes = page.waitForResponse(r => r.url().endsWith("/api/v2/evidence-packages") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Issue & Verify Live Package/i }).click();
    expect([200, 201]).toContain((await issueRes).status());
    await expect(page.getByText(/Issued & verified live backend evidence package/i)).toBeVisible();
    await expect(page.getByText(/VERIFIED: Manifest Hash/i)).toBeVisible();

    await page.getByRole("button", { name: /Inspect Merkle proof for leaf 0/i }).first().click();
    await expect(page.getByRole("heading", { name: /Merkle Inclusion Proof Path \(Leaf #0\)/i })).toBeVisible();

    await page.getByRole("button", { name: /Simulate Artifact Tamper/i }).click();
    await expect(page.getByText(/TAMPER OR MISMATCH DETECTED/i)).toBeVisible();

    await page.getByRole("button", { name: /Load Clean Sample Bundle/i }).click();
    await expect(page.getByText(/VERIFIED: Manifest Hash/i)).toBeVisible();

    await page.getByRole("button", { name: /Re-Verify Bundle/i }).click();
    await expect(page.getByText(/VERIFIED: Manifest Hash/i)).toBeVisible();
  });

  test("Constitutional Invariants tab: OpenAPI 3.1 Contract Registry link serves full spec", async ({ page }) => {
    await openTab(page, "Constitutional Invariants");
    await expect(page.getByRole("heading", { name: /Zoiko Abate Core Mission/i })).toBeVisible();

    const contractLink = page.getByRole("link", { name: /OpenAPI 3\.1 Contract Registry/i });
    await expect(contractLink).toHaveAttribute("href", "/api/v2/contracts/openapi.json");

    const apiRes = await page.request.get(`${BASE_URL}/api/v2/contracts/openapi.json`);
    expect(apiRes.status()).toBe(200);
    const json = await apiRes.json();
    expect(json.openapi).toBe("3.1.0");
    expect(Object.keys(json.paths).length).toBeGreaterThanOrEqual(100);
  });
});
