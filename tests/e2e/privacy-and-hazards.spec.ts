// tests/e2e/privacy-and-hazards.spec.ts
// Browser End-to-End Test for Phase 3 Privacy Release Compiler & Phase 4 Hazard Registration

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Phase 3 Privacy Compiler & Phase 4 Hazards E2E", () => {
  test("suppresses small cohorts (n = 9), releases compliant cohorts (n = 10), and registers an authoritative hazard", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // 1. Cohort Analytics & Privacy (Phase 3)
    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Cohort Analytics & Privacy (Phase 3)", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Deterministic Cohort Measurement & Privacy Release/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /1\. Test n = 9 Floor Violation/i }).click();
    await expect(page.getByText(/RELEASE SUPPRESSED \(SAFE UNAVAILABLE\)/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /2\. Test n = 10 Valid Release/i }).click();
    await expect(page.getByText(/PRIVACY COMPILER RELEASE APPROVED/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/STATUS: RELEASED/i)).toBeVisible({ timeout: 10_000 });

    // 2. Hazards & Controls (Phase 4)
    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Hazards & Controls (Phase 4)", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Hazard Workspace/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Use Seeded Baseline/i }).click();
    await page.getByLabel(/New hazard title/i).fill(`E2E Schedule Unpredictability ${Date.now()}`);
    await page.getByRole("button", { name: /Register Authoritative Hazard/i }).click();
    await expect(page.getByText(/HAZARD REGISTERED IN AUTHORITATIVE STATE/i)).toBeVisible({ timeout: 10_000 });
  });
});
