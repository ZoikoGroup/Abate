// tests/a11y/pages.spec.ts
// Automated Accessibility Audit (Guide §F.8, Page 20)
// Scans real interactive views and tabs for WCAG 2.1 AA serious/critical violations.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

const TAB_AUDIT_NAMES = [
  "Organizations & Idempotency",
  "Cohort Analytics & Privacy (Phase 3)",
  "Hazards & Controls (Phase 4)",
  "Retention & Legal Hold (Phase 5)",
  "Bounded AI & Actions (Phase 6)",
  "Outcomes & AI Change (Phase 7)",
  "Legal Sector Pack (SRA 2023)",
  "Operations & Support (B8)",
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
});
