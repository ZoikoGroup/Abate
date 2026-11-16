// tests/e2e/ingestion-and-minimization.spec.ts
// Browser End-to-End Test for Phase 2 Ingestion, Source Contracts, Decoy Minimization, and Connection Lifecycle

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Phase 2 Ingestion & Connection Lifecycle E2E", () => {
  test("ingests clean batches, drops surveillance decoys, registers CalendarCadence connection, and toggles state", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Ingestion & Work Ledger (Phase 2)", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /Ingestion & Work-State Ledger/i })
    ).toBeVisible({ timeout: 10_000 });

    // 1. Clean ZoikoTime batch
    await page.getByRole("button", { name: /Send Clean Batch/i }).click();
    await expect(page.getByText(/Standard Batch Ingested Successfully/i)).toBeVisible({ timeout: 10_000 });

    // 2. Surveillance decoy rejection
    await page.getByRole("button", { name: /Send Surveillance Decoy/i }).click();
    await expect(page.getByText(/Physical Minimization Confirmed \(Decoy Dropped\)/i)).toBeVisible({ timeout: 10_000 });

    // 3. Register new CalendarCadence connection against approved contract
    const contractSelect = page.getByLabel(/Approved Source Contract/i);
    await expect(contractSelect).toBeVisible({ timeout: 10_000 });
    await contractSelect.selectOption({ value: "00000000-0000-4000-a005-000000000002" });
    await page.getByRole("button", { name: /Register Connection/i }).click();
    await expect(page.getByText(/Source Connection Registered/i)).toBeVisible({ timeout: 10_000 });

    // 4. Pause then resume the newly added connection
    const pauseBtn = page.getByRole("button", { name: "Pause", exact: true }).first();
    await pauseBtn.click();
    await expect(page.getByText(/Connection PAUSED/i)).toBeVisible({ timeout: 10_000 });

    const resumeBtn = page.getByRole("button", { name: "Resume", exact: true }).first();
    await resumeBtn.click();
    await expect(page.getByText(/Connection RESUMED/i)).toBeVisible({ timeout: 10_000 });
  });
});
