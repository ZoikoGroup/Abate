// tests/e2e/organizations.spec.ts
// Playwright End-to-End Test (Guide §F.8, Page 20)
// Validates end-to-end user intent: login, idempotent organization creation, retry replay, conflict detection, and cross-tenant isolation.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
const TENANT_B_ID = "00000000-0000-0000-0000-000000000002";

test.describe("Organizations & Tenant Isolation E2E", () => {
  test("idempotent create, replay, conflict guard, and tenant isolation across Tenant A and Tenant B", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");

    // 1. Ensure Backend Connected badge is visible before issuing commands
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // Click Organizations tab
    await page.getByRole("button", { name: /Organizations & Idempotency/i }).click();

    const testOrgName = `Litigation Practice ${Date.now()}`;
    await page.getByLabel(/Organization \/ Practice Name/i).fill(testOrgName);

    const createBtn = page.getByRole("button", { name: /Create Organization via runCommand/i });
    await expect(createBtn).toBeEnabled({ timeout: 10_000 });
    await createBtn.click();

    // Verify record appears once in Tenant A list
    await expect(page.getByText("COMMAND COMPLETED (SUCCESS)")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("table").getByText(testOrgName)).toHaveCount(1);

    // 2. Replay exact same request (idempotent 200 replay)
    const replayBtn = page.getByRole("button", { name: /Replay Exact Same Request/i });
    await expect(replayBtn).toBeVisible();
    await replayBtn.click();
    await expect(page.locator("table").getByText(testOrgName)).toHaveCount(1);

    // 3. Tamper payload with same idempotency key (expects 409 conflict warning)
    const tamperBtn = page.getByRole("button", { name: /Tamper Payload with Same Key/i });
    await expect(tamperBtn).toBeVisible();
    await tamperBtn.click();
    await expect(page.getByText(/409 CONFLICT: Idempotency Key collision/i)).toBeVisible({ timeout: 10_000 });

    // 4. Switch to Tenant B (Beacon Chambers) and confirm isolation hides Tenant A's organization
    const tenantSelector = page.getByLabel(/Active Tenant Scope/i);
    await tenantSelector.selectOption(TENANT_B_ID);
    await expect(page.getByText(/Active Tenant Organizations \(Beacon Chambers\)/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("table").getByText(testOrgName)).toHaveCount(0);
  });
});
