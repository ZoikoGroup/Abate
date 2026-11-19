// tests/e2e/responsive-and-sector-neutral.spec.ts
// Completion Plan Section 7.4, 7.5 & 8 (G-05, G-26 / T-08, T-21, T-22):
// Verifies responsive layouts (desktop, tablet, phone), keyboard focus traversal,
// and sector-neutral UI behavior when a tenant switches to the GENERIC pack.

import { test, expect } from "@playwright/test";

const TENANT_A_ID = "00000000-0000-4000-a000-00000000000a";

test.describe("Responsive Layouts, Keyboard Traversal & Sector-Neutral Core", () => {
  test("Desktop, tablet, and phone viewports keep primary navigation and actions reachable", async ({ page }) => {
    const viewports = [
      { name: "desktop", width: 1280, height: 800 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "phone", width: 390, height: 844 }
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();

      const orgBtn = page.getByRole("button", { name: "Organizations & Idempotency" });
      await expect(orgBtn).toBeVisible();
      await orgBtn.click();

      const createBtn = page.getByRole("button", { name: /Create Organization/i });
      await expect(createBtn).toBeVisible();
      const box = await createBtn.boundingBox();
      expect(box, `${vp.name} create button must have a bounding box`).not.toBeNull();
      expect(box!.width).toBeGreaterThan(20);
      expect(box!.height).toBeGreaterThan(20);
    }
  });

  test("Keyboard-only Tab navigation moves focus across workspace controls cleanly", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();

    const firstTab = page.getByRole("button", { name: "Organizations & Idempotency" });
    await firstTab.focus();
    await expect(firstTab).toBeFocused();

    await page.keyboard.press("Tab");
    const activeTag = await page.evaluate(() => document.activeElement?.tagName || "");
    expect(activeTag).toBe("BUTTON");
  });

  test("Generic-pack tenant sees zero Legal tab and neutral core vocabulary across tabs", async ({ page, request }) => {
    // Issue Tenant A token to toggle sector profile via authoritative API
    const tokRes = await request.post("/api/v2/auth/token", {
      data: {
        tenantId: TENANT_A_ID,
        subject: "auth0|user-tenant-a-risk-owner",
        role: "RISK_OWNER"
      }
    });
    expect(tokRes.status()).toBe(200);
    const { token } = await tokRes.json();

    try {
      const setGeneric = await request.put("/api/v2/tenant/sector-profile", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `e2e-generic-${Date.now()}`
        },
        data: { sectorKey: "GENERIC", packKey: "generic-work-design" }
      });
      expect(setGeneric.status()).toBe(200);

      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();

      // Legal Sector Pack tab must be hidden for a GENERIC tenant
      await expect(page.getByRole("button", { name: /Legal Sector Pack/i })).toHaveCount(0);

      // Cohort Analytics tab displays neutral core vocabulary (Unit / Team, Demand Window)
      await page.getByRole("button", { name: "Cohort Analytics & Privacy (Phase 3)" }).click();
      await expect(page.getByTestId("sector-vocab-pill")).toContainText("Unit / Team");
      await expect(page.getByTestId("sector-vocab-pill")).toContainText("Demand Window");
    } finally {
      // Restore UK Legal Sector Pack so subsequent tests remain isolated
      await request.put("/api/v2/tenant/sector-profile", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `e2e-restore-legal-${Date.now()}`
        },
        data: { sectorKey: "LEGAL", packKey: "legal-uk-sra" }
      });
    }
  });

  test("Retention tab renders Policy/Sector Entitlements dual-gate panel and executes GDPR Art 17 Rights Request", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "Retention & Legal Hold (Phase 5)" }).click();

    // Policy & Sector Packs dual-gate panel
    const policyCard = page.getByTestId("policy-sector-entitlements-card");
    await expect(policyCard).toBeVisible();
    await expect(policyCard).toContainText("Commercial Entitlement Gate");
    await expect(policyCard).toContainText("Jurisdiction / Policy Gate");

    // GDPR Art 17 Rights Request form
    const rightsCard = page.getByTestId("rights-request-card");
    await expect(rightsCard).toBeVisible();
    await rightsCard.getByLabel(/Subject pseudonym/i).fill(`pseudo_e2e_${Date.now()}`);
    await rightsCard.getByRole("button", { name: /Open rights erasure request/i }).click();
    await expect(page.getByTestId("rights-receipt-banner")).toContainText("Rights Request COMPLETED");
  });
});
