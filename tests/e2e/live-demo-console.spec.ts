// tests/e2e/live-demo-console.spec.ts
// Browser End-to-End Test for Guided Live Demo Console (/demo)

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Live Demo Console E2E", () => {
  test("executes Step 1 live backend check and opens Demo Audit Verification Summary", async ({ page }) => {
    await page.goto(`${BASE_URL}/demo`);
    await page.waitForLoadState("domcontentloaded");

    await expect(page.getByRole("heading", { name: /Live Demo Console/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".step-count-pill")).toHaveText(/Step 1 of 12/i);

    const runBtn = page.locator("button.demo-run-button");
    await expect(runBtn).toBeEnabled({ timeout: 10_000 });
    await runBtn.click();

    await expect(page.locator(".proof-tag")).toHaveText(/PASS/i, { timeout: 10_000 });

    await page.locator("button.btn-summary").click();
    await expect(
      page.getByRole("heading", { name: /Demo Audit Verification Summary/i })
    ).toBeVisible({ timeout: 10_000 });
  });
});
