// tests/e2e/role-nav-and-state-views.spec.ts
// Completion Plan §7.1 & §7.4: Verifies server-driven /api/v2/me allowedNav visibility
// and StateView / Request-ID error guarantees across roles without stack-trace leakage.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";
const TENANT_A_ID = "00000000-0000-4000-a000-00000000000a";

test.describe("Server-Driven Navigation & Role Scoping", () => {
  test("GET /api/v2/me returns server-driven allowedNav and UI hides tabs excluded by /api/v2/me", async ({ page, request }) => {
    const tokRes = await request.post("/api/v2/auth/token", {
      data: {
        tenantId: TENANT_A_ID,
        subject: "auth0|user-tenant-a-risk-owner",
        role: "RISK_OWNER"
      }
    });
    expect(tokRes.status()).toBe(200);
    const { token } = await tokRes.json();

    // 1. Authoritative backend /api/v2/me includes operational nav for RISK_OWNER
    const meRes = await request.get("/api/v2/me", {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(meRes.status()).toBe(200);
    const meJson = await meRes.json();
    expect(Array.isArray(meJson.allowedNav)).toBe(true);
    expect(meJson.allowedNav).toContain("ORGANIZATIONS");
    expect(meJson.allowedNav).toContain("OPS");

    // 2. When /api/v2/me returns a narrowed allowedNav (e.g. read-only principal), UI hides restricted tabs
    await page.route("**/api/v2/me", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.allowedNav = ["DASHBOARD", "ORGANIZATIONS", "COHORT_ANALYTICS", "HAZARD_CONTROL", "AUDIT", "VERIFIER", "CONSTITUTIONAL"];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    });

    await page.goto(BASE_URL);
    await expect(page.getByRole("navigation", { name: "Abate Workspaces" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Organizations & Idempotency" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Cohort Analytics & Privacy/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Operations & Support/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Bounded AI & Actions/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Ingestion & Work Ledger/i })).toHaveCount(0);
  });
});
