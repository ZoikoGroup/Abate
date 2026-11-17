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

  test("runs all 12 demo steps in order and asserts expected 409 and 400 refusals", async ({ page }) => {
    await page.goto(`${BASE_URL}/demo`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: /Live Demo Console/i })).toBeVisible({ timeout: 15_000 });

    const expectedStatuses: Record<number, number> = {
      1: 200,
      2: 200,
      3: 200,
      4: 200,
      5: 200,
      6: 409,
      7: 400,
      8: 200,
      9: 200,
      10: 200,
      11: 200,
      12: 200
    };

    for (let step = 1; step <= 12; step++) {
      await expect(page.locator(".step-count-pill")).toHaveText(new RegExp(`Step ${step} of 12`, "i"), { timeout: 10_000 });

      const runBtn = page.locator("button.demo-run-button");
      await expect(runBtn).toBeEnabled({ timeout: 10_000 });

      const responsePromise = page.waitForResponse((res) => {
        const u = res.url();
        if (step === 1) return u.includes("/api/health");
        if (step === 2) return u.includes("/api/v2/contracts/openapi.json");
        if (step === 3) return u.includes("/api/v2/auth/token");
        if (step === 4 || step === 5 || step === 6 || step === 7 || step === 11) {
          return u.includes("/api/v2/organizations") && res.request().method() === "POST";
        }
        if (step === 8 || step === 12) return u.includes("/api/v2/organizations") && res.request().method() === "GET";
        if (step === 9) return u.includes("/test-report.json");
        if (step === 10) return u.includes("/api/v2/release/dossier");
        return false;
      });

      await runBtn.click();
      const resp = await responsePromise;
      if (step === 4 || step === 11) {
        expect([200, 201]).toContain(resp.status());
      } else {
        expect(resp.status()).toBe(expectedStatuses[step]);
      }

      await expect(page.locator(".proof-tag")).toHaveText(/PASS/i, { timeout: 10_000 });

      if (step === 6 || step === 7) {
        const expCode = step === 6 ? 409 : 400;
        await expect(page.locator(".action-card .expected-refusal-banner .expected-refusal-badge")).toHaveText(`Expected: ${expCode}`);
        await expect(page.locator(".action-card .expected-refusal-banner .expected-refusal-note")).toContainText("The backend refused this on purpose.");
        await expect(page.locator(".inspector-header .status-expected-refusal")).toContainText(String(expCode));
        await expect(page.locator(".inspector-header .status-4xx")).toHaveCount(0);
      }

      // Check masked JWT in cURL preview once authenticated steps run
      if (step >= 4 && step <= 8) {
        const curlBtn = page.getByRole("button", { name: /cURL/i });
        if (await curlBtn.isVisible()) {
          await curlBtn.click();
          const curlText = await page.locator("pre").first().innerText();
          if (curlText.includes("Authorization: Bearer")) {
            expect(curlText).not.toMatch(/Bearer\s+eyJ[A-Za-z0-9_-]{20,}/);
          }
        }
      }

      if (step < 12) {
        const nextBtn = page.locator("button.demo-next-button");
        await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
        await nextBtn.click();
      }
    }

    // Step 12 automatically opens the Demo Audit Verification Summary modal
    const summaryHeading = page.getByRole("heading", { name: /Demo Audit Verification Summary/i });
    await expect(summaryHeading).toBeVisible({ timeout: 10_000 });

    const summaryRows = page.locator(".summary-table tbody tr");
    await expect(summaryRows).toHaveCount(12);
    for (let i = 0; i < 12; i++) {
      await expect(summaryRows.nth(i)).toContainText("PASS");
    }
    await expect(summaryRows.nth(5)).toContainText("Expected: 409");
    await expect(summaryRows.nth(5)).toContainText("The backend refused this on purpose.");
    await expect(summaryRows.nth(5).locator(".status-expected-refusal")).toContainText("409");
    await expect(summaryRows.nth(6)).toContainText("Expected: 400");
    await expect(summaryRows.nth(6)).toContainText("The backend refused this on purpose.");
    await expect(summaryRows.nth(6).locator(".status-expected-refusal")).toContainText("400");
  });
});
