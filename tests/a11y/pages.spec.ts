// tests/a11y/pages.spec.ts
// Automated Accessibility Audit (Guide §F.8, Page 20)
// Scans real interactive views and tabs for WCAG 2.1 AA serious/critical violations.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

const TAB_AUDIT_NAMES = [
  "Organizations & Idempotency",
  "Ingestion & Work Ledger (Phase 2)",
  "Cohort Analytics & Privacy (Phase 3)",
  "Hazards & Controls (Phase 4)",
  "Retention & Legal Hold (Phase 5)",
  "Bounded AI & Actions (Phase 6)",
  "Outcomes & AI Change (Phase 7)",
  "Legal Sector Pack (SRA 2023)",
  "Operations & Support (B8)",
  "Tenant Isolation & Attack Lab",
  "Transactional Outbox",
  "Append-Only Audit Trail",
  "Audit Verifier & Merkle",
  "Constitutional Invariants"
];

test.describe("WCAG 2.1 AA Accessibility Gates", () => {
  for (const tabName of TAB_AUDIT_NAMES) {
    test(`no serious or critical a11y violations on ${tabName}`, async ({ page }) => {
      await page.goto(BASE_URL);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

      await page.locator("nav.tabs-navigation").getByRole("button", { name: tabName, exact: true }).click();
      await page.waitForTimeout(200);

      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const severeViolations = accessibilityScanResults.violations.filter((v) =>
        ["serious", "critical"].includes(v.impact ?? "")
      );

      if (severeViolations.length > 0) {
        console.error(`A11y violations found on ${tabName}:`, JSON.stringify(severeViolations, null, 2));
      }

      expect(severeViolations).toEqual([]);
    });
  }

  test("no serious or critical a11y violations on Live Demo Console", async ({ page }) => {
    await page.goto(`${BASE_URL}/demo`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(250);

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const severeViolations = accessibilityScanResults.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? "")
    );

    if (severeViolations.length > 0) {
      console.error("A11y violations found on Live Demo Console:", JSON.stringify(severeViolations, null, 2));
    }

    expect(severeViolations).toEqual([]);
  });

  for (const vp of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "phone", width: 390, height: 844 }
  ]) {
    test(`responsive layout keeps navigation & primary actions reachable at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(BASE_URL);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

      const navBtn = page.locator("nav.tabs-navigation").getByRole("button", { name: "Ingestion & Work Ledger (Phase 2)", exact: true });
      await navBtn.scrollIntoViewIfNeeded();
      await expect(navBtn).toBeVisible();
      await navBtn.click();

      const sendBtn = page.getByRole("button", { name: /Send Clean Batch/i });
      await sendBtn.scrollIntoViewIfNeeded();
      await expect(sendBtn).toBeVisible();

      const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflowPx).toBeLessThanOrEqual(24);
    });
  }
});
