# Test info

- Name: Responsive Layouts, Keyboard Traversal & Sector-Neutral Core >> Keyboard-only Tab navigation moves focus across workspace controls cleanly
- Location: C:\Users\aparaziitha nitta\Abate\tests\e2e\responsive-and-sector-neutral.spec.ts:36:7

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

    at C:\Users\aparaziitha nitta\Abate\tests\e2e\responsive-and-sector-neutral.spec.ts:38:16
```

# Test source

```ts
   1 | // tests/e2e/responsive-and-sector-neutral.spec.ts
   2 | // Completion Plan Section 7.4, 7.5 & 8 (G-05, G-26 / T-08, T-21, T-22):
   3 | // Verifies responsive layouts (desktop, tablet, phone), keyboard focus traversal,
   4 | // and sector-neutral UI behavior when a tenant switches to the GENERIC pack.
   5 |
   6 | import { test, expect } from "@playwright/test";
   7 |
   8 | const TENANT_A_ID = "00000000-0000-4000-a000-00000000000a";
   9 |
   10 | test.describe("Responsive Layouts, Keyboard Traversal & Sector-Neutral Core", () => {
   11 |   test("Desktop, tablet, and phone viewports keep primary navigation and actions reachable", async ({ page }) => {
   12 |     const viewports = [
   13 |       { name: "desktop", width: 1280, height: 800 },
   14 |       { name: "tablet", width: 768, height: 1024 },
   15 |       { name: "phone", width: 390, height: 844 }
   16 |     ];
   17 |
   18 |     for (const vp of viewports) {
   19 |       await page.setViewportSize({ width: vp.width, height: vp.height });
   20 |       await page.goto("/");
   21 |       await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();
   22 |
   23 |       const orgBtn = page.getByRole("button", { name: "Organizations & Idempotency" });
   24 |       await expect(orgBtn).toBeVisible();
   25 |       await orgBtn.click();
   26 |
   27 |       const createBtn = page.getByRole("button", { name: /Create Organization/i });
   28 |       await expect(createBtn).toBeVisible();
   29 |       const box = await createBtn.boundingBox();
   30 |       expect(box, `${vp.name} create button must have a bounding box`).not.toBeNull();
   31 |       expect(box!.width).toBeGreaterThan(20);
   32 |       expect(box!.height).toBeGreaterThan(20);
   33 |     }
   34 |   });
   35 |
   36 |   test("Keyboard-only Tab navigation moves focus across workspace controls cleanly", async ({ page }) => {
   37 |     await page.setViewportSize({ width: 1280, height: 800 });
>  38 |     await page.goto("/");
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
   39 |     await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();
   40 |
   41 |     const firstTab = page.getByRole("button", { name: "Organizations & Idempotency" });
   42 |     await firstTab.focus();
   43 |     await expect(firstTab).toBeFocused();
   44 |
   45 |     await page.keyboard.press("Tab");
   46 |     const activeTag = await page.evaluate(() => document.activeElement?.tagName || "");
   47 |     expect(activeTag).toBe("BUTTON");
   48 |   });
   49 |
   50 |   test("Generic-pack tenant sees zero Legal tab and neutral core vocabulary across tabs", async ({ page, request }) => {
   51 |     // Issue Tenant A token to toggle sector profile via authoritative API
   52 |     const tokRes = await request.post("/api/v2/auth/token", {
   53 |       data: {
   54 |         tenantId: TENANT_A_ID,
   55 |         subject: "auth0|user-tenant-a-risk-owner",
   56 |         role: "RISK_OWNER"
   57 |       }
   58 |     });
   59 |     expect(tokRes.status()).toBe(200);
   60 |     const { token } = await tokRes.json();
   61 |
   62 |     try {
   63 |       const setGeneric = await request.put("/api/v2/tenant/sector-profile", {
   64 |         headers: {
   65 |           Authorization: `Bearer ${token}`,
   66 |           "Idempotency-Key": `e2e-generic-${Date.now()}`
   67 |         },
   68 |         data: { sectorKey: "GENERIC", packKey: "generic-work-design" }
   69 |       });
   70 |       expect(setGeneric.status()).toBe(200);
   71 |
   72 |       await page.goto("/");
   73 |       await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();
   74 |
   75 |       // Legal Sector Pack tab must be hidden for a GENERIC tenant
   76 |       await expect(page.getByRole("button", { name: /Legal Sector Pack/i })).toHaveCount(0);
   77 |
   78 |       // Cohort Analytics tab displays neutral core vocabulary (Unit / Team, Demand Window)
   79 |       await page.getByRole("button", { name: "Cohort Analytics & Privacy (Phase 3)" }).click();
   80 |       await expect(page.getByTestId("sector-vocab-pill")).toContainText("Unit / Team");
   81 |       await expect(page.getByTestId("sector-vocab-pill")).toContainText("Demand Window");
   82 |     } finally {
   83 |       // Restore UK Legal Sector Pack so subsequent tests remain isolated
   84 |       await request.put("/api/v2/tenant/sector-profile", {
   85 |         headers: {
   86 |           Authorization: `Bearer ${token}`,
   87 |           "Idempotency-Key": `e2e-restore-legal-${Date.now()}`
   88 |         },
   89 |         data: { sectorKey: "LEGAL", packKey: "legal-uk-sra" }
   90 |       });
   91 |     }
   92 |   });
   93 |
   94 |   test("Retention tab renders Policy/Sector Entitlements dual-gate panel and executes GDPR Art 17 Rights Request", async ({ page }) => {
   95 |     await page.setViewportSize({ width: 1280, height: 800 });
   96 |     await page.goto("/");
   97 |     await page.getByRole("button", { name: "Retention & Legal Hold (Phase 5)" }).click();
   98 |
   99 |     // Policy & Sector Packs dual-gate panel
  100 |     const policyCard = page.getByTestId("policy-sector-entitlements-card");
  101 |     await expect(policyCard).toBeVisible();
  102 |     await expect(policyCard).toContainText("Commercial Entitlement Gate");
  103 |     await expect(policyCard).toContainText("Jurisdiction / Policy Gate");
  104 |
  105 |     // GDPR Art 17 Rights Request form
  106 |     const rightsCard = page.getByTestId("rights-request-card");
  107 |     await expect(rightsCard).toBeVisible();
  108 |     await rightsCard.getByLabel(/Subject pseudonym/i).fill(`pseudo_e2e_${Date.now()}`);
  109 |     await rightsCard.getByRole("button", { name: /Open rights erasure request/i }).click();
  110 |     await expect(page.getByTestId("rights-receipt-banner")).toContainText("Rights Request COMPLETED");
  111 |   });
  112 | });
  113 |
```