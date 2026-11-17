# Test info

- Name: All Tabs & Buttons Full Real Verification >> Outcomes & AI Change (Phase 7) tab: Plane B toggle, prohibited claim, evaluation & AI change work
- Location: C:\Users\aparaziitha nitta\Abate\tests\e2e\all-tabs-buttons.spec.ts:378:7

# Error details

```
Error: page.goto: net::ERR_NETWORK_ACCESS_DENIED at http://127.0.0.1:5173/
Call log:
  - navigating to "http://127.0.0.1:5173/", waiting until "load"

    at openTab (C:\Users\aparaziitha nitta\Abate\tests\e2e\all-tabs-buttons.spec.ts:11:14)
    at C:\Users\aparaziitha nitta\Abate\tests\e2e\all-tabs-buttons.spec.ts:379:11
```

# Test source

```ts
   1 | // tests/e2e/all-tabs-buttons.spec.ts
   2 | // Comprehensive per-tab interactive button and real HTTP verification suite.
   3 | // Verifies every tab, button, form, and link across the entire Abate frontend.
   4 |
   5 | import { test, expect, type Page } from "@playwright/test";
   6 |
   7 | const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
   8 | const TENANT_B_ID = "00000000-0000-4000-b000-00000000000b";
   9 |
   10 | async function openTab(page: Page, tabName: string) {
>  11 |   await page.goto(BASE_URL);
      |              ^ Error: page.goto: net::ERR_NETWORK_ACCESS_DENIED at http://127.0.0.1:5173/
   12 |   await page.waitForLoadState("domcontentloaded");
   13 |   await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });
   14 |   const navBtn = page.locator("nav.tabs-navigation").getByRole("button", { name: tabName, exact: true });
   15 |   await navBtn.click();
   16 | }
   17 |
   18 | test.describe("All Tabs & Buttons Full Real Verification", () => {
   19 |   test.beforeEach(async ({ page }) => {
   20 |     page.on("dialog", async (dialog) => {
   21 |       throw new Error(`Unexpected browser dialog (${dialog.type()}): ${dialog.message()}`);
   22 |     });
   23 |   });
   24 |
   25 |   test("Navbar: tenant switch, role switch, refresh, live demo toggle & dev mode session", async ({ page }) => {
   26 |     await page.goto(BASE_URL);
   27 |     await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });
   28 |
   29 |     // Switch Role
   30 |     const roleSelect = page.getByLabel(/Effective Domain Role:/i);
   31 |     await roleSelect.selectOption("REVIEWER");
   32 |     await expect(roleSelect).toHaveValue("REVIEWER");
   33 |     await roleSelect.selectOption("RISK_OWNER");
   34 |
   35 |     // Switch Tenant
   36 |     const tenantSelect = page.getByLabel(/Active Tenant Scope:/i);
   37 |     const tenantBRes = page.waitForResponse(r => r.url().includes("/api/v2/auth/token") && r.request().method() === "POST");
   38 |     await tenantSelect.selectOption(TENANT_B_ID);
   39 |     expect((await tenantBRes).status()).toBe(200);
   40 |     await expect(page.getByText(/Active Tenant Organizations \(Beacon Chambers/i)).toBeVisible({ timeout: 10_000 });
   41 |
   42 |     // Refresh
   43 |     const refreshRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "GET");
   44 |     await page.getByRole("button", { name: "Refresh live data" }).click();
   45 |     expect((await refreshRes).status()).toBe(200);
   46 |
   47 |     // Launch Live Demo Console & return
   48 |     await page.getByRole("button", { name: /Launch Guided Live Demo Console/i }).click();
   49 |     await expect(page.getByRole("heading", { name: /Live Demo Console/i })).toBeVisible({ timeout: 10_000 });
   50 |     await page.getByRole("button", { name: /Back to App/i }).click();
   51 |     await expect(page.locator("nav.tabs-navigation")).toBeVisible({ timeout: 10_000 });
   52 |   });
   53 |
   54 |   test("Organizations & Idempotency tab: every button & error path works cleanly", async ({ page }) => {
   55 |     await openTab(page, "Organizations & Idempotency");
   56 |     const uniqueName = `Chambers Unit ${Date.now()}`;
   57 |
   58 |     await page.getByRole("button", { name: /Generate New Key/i }).click();
   59 |     await page.getByLabel(/Organization \/ Practice Name/i).fill(uniqueName);
   60 |
   61 |     const createRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
   62 |     await page.getByRole("button", { name: /Create Organization via runCommand/i }).click();
   63 |     expect([200, 201]).toContain((await createRes).status());
   64 |     await expect(page.getByText("COMMAND COMPLETED (SUCCESS)")).toBeVisible();
   65 |     await expect(page.locator("table").getByText(uniqueName)).toHaveCount(1);
   66 |
   67 |     const replayRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
   68 |     await page.getByRole("button", { name: /Replay Exact Same Request/i }).click();
   69 |     expect((await replayRes).status()).toBe(200);
   70 |     await expect(page.locator("table").getByText(uniqueName)).toHaveCount(1);
   71 |
   72 |     const conflictRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
   73 |     await page.getByRole("button", { name: /Tamper Payload with Same Key/i }).click();
   74 |     expect((await conflictRes).status()).toBe(409);
   75 |     await expect(page.getByText(/409 CONFLICT: Idempotency Key collision/i)).toBeVisible();
   76 |     await expect(page.getByText(/Request ID:/i)).toBeVisible();
   77 |
   78 |     await page.getByLabel(/Inject prohibited field/i).check();
   79 |     await page.getByLabel(/Organization \/ Practice Name/i).fill("Surveillance Probe Org");
   80 |     const decoyRes = page.waitForResponse(r => r.url().includes("/api/v2/organizations") && r.request().method() === "POST");
   81 |     await page.getByRole("button", { name: /Create Organization via runCommand/i }).click();
   82 |     expect((await decoyRes).status()).toBe(400);
   83 |     await expect(page.getByText(/CONSTITUTIONAL BOUNDARY DEFENDED/i)).toBeVisible();
   84 |   });
   85 |
   86 |   test("Ingestion & Work Ledger (Phase 2) tab: every batch, decoy, revision & connection control works", async ({ page }) => {
   87 |     await openTab(page, "Ingestion & Work Ledger (Phase 2)");
   88 |     await expect(page.getByRole("heading", { name: /Ingestion & Work-State Ledger/i })).toBeVisible();
   89 |
   90 |     const cleanRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
   91 |     await page.getByRole("button", { name: /Send Clean Batch/i }).click();
   92 |     expect((await cleanRes).status()).toBe(200);
   93 |     await expect(page.getByText(/Standard Batch Ingested Successfully/i)).toBeVisible();
   94 |     await expect(page.getByText(/Batch "undefined"/i)).toHaveCount(0);
   95 |
   96 |     const dupRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
   97 |     await page.getByRole("button", { name: /Send Duplicate Replay/i }).click();
   98 |     expect((await dupRes).status()).toBe(200);
   99 |     await expect(page.getByText(/Duplicate Batch Handled Idempotently/i)).toBeVisible();
  100 |
  101 |     const decoyRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
  102 |     await page.getByRole("button", { name: /Send Surveillance Decoy/i }).click();
  103 |     expect((await decoyRes).status()).toBe(400);
  104 |     await expect(page.getByText(/Physical Minimization Confirmed/i)).toBeVisible();
  105 |
  106 |     const revRes = page.waitForResponse(r => r.url().includes("/api/v2/connectors/zoikotime/batches") && r.request().method() === "POST");
  107 |     await page.getByRole("button", { name: /Send Revision 2/i }).click();
  108 |     expect((await revRes).status()).toBe(200);
  109 |     await expect(page.getByText(/Revision 2 Appended to Ledger/i)).toBeVisible();
  110 |
  111 |     const regRes = page.waitForResponse(r => r.url().includes("/api/v2/connections") && r.request().method() === "POST");
```