// tests/a11y/pages.spec.ts
// Automated Accessibility Audit (Guide §F.8, Page 20)
// Audits routes for WCAG 2.1 AA violations (0 serious or critical accessibility violations).

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://localhost:5173";

const AUDIT_ROUTES = [
  "/",
  "/#demo",
  "/#organizations",
  "/#analytics",
  "/#hazards",
  "/#retention",
  "/#operations"
];

test.describe("WCAG 2.1 AA Accessibility Gates", () => {
  for (const route of AUDIT_ROUTES) {
    test(`no serious or critical a11y violations on ${route}`, async ({ page }) => {
      await page.goto(`${BASE_URL}${route}`);
      await page.waitForLoadState("domcontentloaded");

      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const severeViolations = accessibilityScanResults.violations.filter(v =>
        ["serious", "critical"].includes(v.impact ?? "")
      );

      if (severeViolations.length > 0) {
        console.error(`A11y violations found on ${route}:`, JSON.stringify(severeViolations, null, 2));
      }

      expect(severeViolations).toEqual([]);
    });
  }
});

