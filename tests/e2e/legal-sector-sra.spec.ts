// tests/e2e/legal-sector-sra.spec.ts
// Browser End-to-End Test for Domain S13: UK Legal Practice Pack & SRA-Aligned Controls

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Legal Sector Pack (SRA 2023) E2E", () => {
  test("detects trial-window fatigue surge and enforces physical minimization boundary gate", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Legal Sector Pack (SRA 2023)", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /UK Legal Practice & Workplace Culture/i })
    ).toBeVisible({ timeout: 10_000 });

    const fatigueBtn = page.getByRole("button", { name: /SRA Fatigue Check/i }).first();
    await expect(fatigueBtn).toBeVisible({ timeout: 10_000 });
    await fatigueBtn.click();

    await expect(page.getByText(/SRA SURGE ALERT: FATIGUE DETECTED/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Mandatory Supervisory Partner Consultation Gate/i)).toBeVisible();

    const privilegeCheckbox = page.locator("#inject-privilege-check");
    const translateBtn = page.getByRole("button", { name: /Execute Translation & Boundary Gate/i });

    await privilegeCheckbox.check();
    await translateBtn.click();
    await expect(page.getByText(/Constitutional Boundary Defended/i)).toBeVisible({ timeout: 10_000 });

    await privilegeCheckbox.uncheck();
    await translateBtn.click();
    await expect(page.getByText(/Mapped Neutral Representation \(Zero Privilege Leak\)/i)).toBeVisible({ timeout: 10_000 });
  });
});
