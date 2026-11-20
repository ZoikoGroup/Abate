# Test info

- Name: WCAG 2.1 AA Accessibility Gates >> responsive layout keeps navigation & primary actions reachable at desktop (1280x800)
- Location: C:\Users\aparaziitha nitta\Abate\tests\a11y\pages.spec.ts:78:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
Call log:
  - navigating to "http://127.0.0.1:5173/", waiting until "load"

    at C:\Users\aparaziitha nitta\Abate\tests\a11y\pages.spec.ts:80:18
```

# Test source

```ts
   1 | // tests/a11y/pages.spec.ts
   2 | // Automated Accessibility Audit (Guide §F.8, Page 20)
   3 | // Scans real interactive views and tabs for WCAG 2.1 AA serious/critical violations.
   4 |
   5 | import { test, expect } from "@playwright/test";
   6 | import AxeBuilder from "@axe-core/playwright";
   7 |
   8 | const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
   9 |
  10 | const TAB_AUDIT_NAMES = [
  11 |   "Organizations & Idempotency",
  12 |   "Ingestion & Work Ledger (Phase 2)",
  13 |   "Cohort Analytics & Privacy (Phase 3)",
  14 |   "Hazards & Controls (Phase 4)",
  15 |   "Retention & Legal Hold (Phase 5)",
  16 |   "Bounded AI & Actions (Phase 6)",
  17 |   "Outcomes & AI Change (Phase 7)",
  18 |   "Legal Sector Pack (SRA 2023)",
  19 |   "Operations & Support (B8)",
  20 |   "Tenant Isolation & Attack Lab",
  21 |   "Transactional Outbox",
  22 |   "Append-Only Audit Trail",
  23 |   "Audit Verifier & Merkle",
  24 |   "Constitutional Invariants"
  25 | ];
  26 |
  27 | test.describe("WCAG 2.1 AA Accessibility Gates", () => {
  28 |   for (const tabName of TAB_AUDIT_NAMES) {
  29 |     test(`no serious or critical a11y violations on ${tabName}`, async ({ page }) => {
  30 |       await page.goto(BASE_URL);
  31 |       await page.waitForLoadState("domcontentloaded");
  32 |       await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });
  33 |
  34 |       await page.locator("nav.tabs-navigation").getByRole("button", { name: tabName, exact: true }).click();
  35 |       await page.waitForTimeout(200);
  36 |
  37 |       const accessibilityScanResults = await new AxeBuilder({ page })
  38 |         .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
  39 |         .analyze();
  40 |
  41 |       const severeViolations = accessibilityScanResults.violations.filter((v) =>
  42 |         ["serious", "critical"].includes(v.impact ?? "")
  43 |       );
  44 |
  45 |       if (severeViolations.length > 0) {
  46 |         console.error(`A11y violations found on ${tabName}:`, JSON.stringify(severeViolations, null, 2));
  47 |       }
  48 |
  49 |       expect(severeViolations).toEqual([]);
  50 |     });
  51 |   }
  52 |
  53 |   test("no serious or critical a11y violations on Live Demo Console", async ({ page }) => {
  54 |     await page.goto(`${BASE_URL}/demo`);
  55 |     await page.waitForLoadState("domcontentloaded");
  56 |     await page.waitForTimeout(250);
  57 |
  58 |     const accessibilityScanResults = await new AxeBuilder({ page })
  59 |       .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
  60 |       .analyze();
  61 |
  62 |     const severeViolations = accessibilityScanResults.violations.filter((v) =>
  63 |       ["serious", "critical"].includes(v.impact ?? "")
  64 |     );
  65 |
  66 |     if (severeViolations.length > 0) {
  67 |       console.error("A11y violations found on Live Demo Console:", JSON.stringify(severeViolations, null, 2));
  68 |     }
  69 |
  70 |     expect(severeViolations).toEqual([]);
  71 |   });
  72 |
  73 |   for (const vp of [
  74 |     { name: "desktop", width: 1280, height: 800 },
  75 |     { name: "tablet", width: 768, height: 1024 },
  76 |     { name: "phone", width: 390, height: 844 }
  77 |   ]) {
  78 |     test(`responsive layout keeps navigation & primary actions reachable at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
  79 |       await page.setViewportSize({ width: vp.width, height: vp.height });
> 80 |       await page.goto(BASE_URL);
     |                  ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
  81 |       await page.waitForLoadState("domcontentloaded");
  82 |       await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });
  83 |
  84 |       const navBtn = page.locator("nav.tabs-navigation").getByRole("button", { name: "Ingestion & Work Ledger (Phase 2)", exact: true });
  85 |       await navBtn.scrollIntoViewIfNeeded();
  86 |       await expect(navBtn).toBeVisible();
  87 |       await navBtn.click();
  88 |
  89 |       const sendBtn = page.getByRole("button", { name: /Send Clean Batch/i });
  90 |       await sendBtn.scrollIntoViewIfNeeded();
  91 |       await expect(sendBtn).toBeVisible();
  92 |
  93 |       const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  94 |       expect(overflowPx).toBeLessThanOrEqual(24);
  95 |     });
  96 |   }
  97 | });
  98 |
```