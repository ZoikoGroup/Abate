// tests/e2e/retention-and-ops.spec.ts
// Browser End-to-End Test for Phase 5 Retention & Legal Hold and Phase 8 Zero-Impersonation Support & Ratified Dossier

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Phase 5 Legal Holds & Phase 8 Support Operations E2E", () => {
  test("places and releases a legal hold, signs in as support, verifies diagnostic receipt, and displays ratified dossier", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // 1. Retention & Legal Hold (Phase 5)
    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Retention & Legal Hold (Phase 5)", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Jurisdiction Pack in Effect/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("COVERED", { exact: true })).toBeVisible();

    const matterId = `MATTER-E2E-${Date.now().toString().slice(-5)}`;
    await page.getByLabel(/Work item \/ Hold reference|Matter reference/i).fill(matterId);
    await page.getByLabel(/^Reason$/i).fill("Regulatory preservation notice during E2E test");
    await page.getByRole("button", { name: /Place legal hold/i }).click();
    await expect(page.getByText(/Legal hold placed/i)).toBeVisible({ timeout: 10_000 });

    await page.getByLabel(`Release reason for ${matterId}`).fill("E2E hold release verification completed");
    await page.getByRole("button", { name: "Release", exact: true }).first().click();
    await expect(page.getByText(/Legal hold released/i)).toBeVisible({ timeout: 10_000 });

    // 2. Operations & Support (B8)
    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Operations & Support (B8)", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Tenant: Diagnostic Receipt for Support/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Issue diagnostic receipt/i }).click();
    await expect(page.getByText(/Diagnostic receipt issued/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Sign in as support operator/i }).click();
    await expect(page.getByText(/Support session started/i)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("heading", { name: /Release Evidence Dossier Gates/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/STATUS:\s*(READY FOR REVIEW|RATIFIED)/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Verify signature/i }).click();
    await expect(page.getByText(/Receipt checked/i)).toBeVisible({ timeout: 10_000 });
  });
});
