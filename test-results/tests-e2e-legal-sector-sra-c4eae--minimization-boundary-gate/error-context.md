# Test info

- Name: Legal Sector Pack (SRA 2023) E2E >> detects trial-window fatigue surge and enforces physical minimization boundary gate
- Location: C:\Users\aparaziitha nitta\Abate\tests\e2e\legal-sector-sra.spec.ts:9:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
Call log:
  - navigating to "http://127.0.0.1:5173/", waiting until "load"

    at C:\Users\aparaziitha nitta\Abate\tests\e2e\legal-sector-sra.spec.ts:10:16
```

# Test source

```ts
   1 | // tests/e2e/legal-sector-sra.spec.ts
   2 | // Browser End-to-End Test for Domain S13: UK Legal Practice Pack & SRA-Aligned Controls
   3 |
   4 | import { test, expect } from "@playwright/test";
   5 |
   6 | const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
   7 |
   8 | test.describe("Legal Sector Pack (SRA 2023) E2E", () => {
   9 |   test("detects trial-window fatigue surge and enforces physical minimization boundary gate", async ({ page }) => {
> 10 |     await page.goto(BASE_URL);
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
  11 |     await page.waitForLoadState("domcontentloaded");
  12 |     await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });
  13 |
  14 |     await page.locator("nav.tabs-navigation").getByRole("button", { name: "Legal Sector Pack (SRA 2023)", exact: true }).click();
  15 |     await expect(
  16 |       page.getByRole("heading", { name: /UK Legal Practice & Workplace Culture/i })
  17 |     ).toBeVisible({ timeout: 10_000 });
  18 |
  19 |     const fatigueBtn = page.getByRole("button", { name: /SRA Fatigue Check/i }).first();
  20 |     await expect(fatigueBtn).toBeVisible({ timeout: 10_000 });
  21 |     await fatigueBtn.click();
  22 |
  23 |     await expect(page.getByText(/SRA SURGE ALERT: FATIGUE DETECTED/i)).toBeVisible({ timeout: 10_000 });
  24 |     await expect(page.getByText(/Mandatory Supervisory Partner Consultation Gate/i)).toBeVisible();
  25 |
  26 |     const privilegeCheckbox = page.getByLabel(/Inject Privileged Legal Advice/i);
  27 |     const translateBtn = page.getByRole("button", { name: /Execute Translation & Boundary Gate/i });
  28 |
  29 |     await privilegeCheckbox.check();
  30 |     await translateBtn.click();
  31 |     await expect(page.getByText(/Constitutional Boundary Defended/i)).toBeVisible({ timeout: 10_000 });
  32 |
  33 |     await privilegeCheckbox.uncheck();
  34 |     await translateBtn.click();
  35 |     await expect(page.getByText(/Mapped Neutral Representation \(Zero Confidential Leak\)/i)).toBeVisible({ timeout: 10_000 });
  36 |   });
  37 | });
  38 |
```