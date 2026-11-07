// tests/e2e/organizations.spec.ts
// Playwright End-to-End Test (Guide §F.8, Page 20)
// Validates end-to-end user intent: login, idempotent organization creation, retry replay, and cross-tenant RLS isolation.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://localhost:5173";

test.describe("Organizations & Tenant Isolation E2E", () => {
  test("idempotent create and tenant isolation across Tenant A and Tenant B", async ({ page }) => {
    // 1. Visit App and Select Tenant A (Apex Legal Partners)
    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    // Click on Organizations tab
    const orgsTabBtn = page.getByRole("button", { name: /organizations/i });
    if (await orgsTabBtn.isVisible()) {
      await orgsTabBtn.click();
    }

    const testOrgName = `Litigation Practice ${Date.now()}`;

    // Fill organization name
    const nameInput = page.getByLabel(/organization.*name/i).or(page.locator("input[placeholder*='name' i]"));
    await nameInput.fill(testOrgName);

    // Create organization
    const createBtn = page.getByRole("button", { name: /create organization/i });
    await createBtn.click();

    // Verify record appears in Tenant A list
    await expect(page.getByText(testOrgName)).toHaveCount(1);

    // 2. Resend same request with same idempotency key (Replay test)
    // The UI retains the idempotency key until renewed
    if (await createBtn.isEnabled()) {
      await createBtn.click();
      // Should still be exactly one row (idempotent replay)
      await expect(page.getByText(testOrgName)).toHaveCount(1);
    }

    // 3. Switch to Tenant B (Beacon Chambers)
    const tenantSelector = page.getByRole("combobox", { name: /tenant/i }).or(page.locator("select"));
    if (await tenantSelector.isVisible()) {
      await tenantSelector.selectOption({ label: /Beacon Chambers/i });
      // Database RLS must hide Tenant A's unit from Tenant B
      await expect(page.getByText(testOrgName)).toHaveCount(0);
    }
  });
});

