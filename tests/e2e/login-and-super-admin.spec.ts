import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.BASE_URL || process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Login Screen, Sign Out, and Super Admin Console", () => {
  test("can sign out to Login screen, switch to Super Admin, manage tenants, and pass Axe", async ({ page }) => {
    await page.goto(BASE_URL);

    // Sign out from initial tenant session
    const signOutBtn = page.getByRole("button", { name: /Sign out/i });
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();

    // Login screen renders cleanly
    await expect(page.getByRole("heading", { name: /Sign in to Zoiko Abate/i })).toBeVisible();
    const loginAxe = await new AxeBuilder({ page }).analyze();
    expect(loginAxe.violations).toEqual([]);

    // Switch to Super Admin tab and sign in
    await page.getByRole("tab", { name: /Super Admin \/ Platform Console/i }).click();
    await page.getByRole("button", { name: /Sign In as Super Admin/i }).click();

    // Super Admin Console loads Platform Overview
    await expect(page.getByText(/ZOIKO ABATE — SUPER ADMIN/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Platform Overview/i })).toBeVisible();

    // Navigate to Tenant Management and create a tenant
    await page.getByRole("button", { name: "Tenant Management" }).click();
    await page.getByLabel("New Tenant Name").fill("E2E SuperAdmin Corp");
    await page.getByRole("button", { name: "Create Tenant" }).click();
    await expect(page.getByText(/Created tenant "E2E SuperAdmin Corp"/i)).toBeVisible();

    // Navigate to Users & Access, Governance, Operations, and Evidence tabs
    await page.getByRole("button", { name: "Users & Access" }).click();
    await expect(page.getByRole("heading", { name: /Users, Principals & Role Memberships/i })).toBeVisible();

    await page.getByRole("button", { name: "Governance & Flags" }).click();
    await expect(page.getByRole("heading", { name: /Governance Packs & Feature Flags/i })).toBeVisible();

    await page.getByRole("button", { name: "Worker & Kill Switches" }).click();
    await expect(page.getByRole("heading", { name: /Platform Operations, Kill Switches/i })).toBeVisible();

    await page.getByRole("button", { name: "Evidence & Dossier" }).click();
    await expect(page.getByRole("heading", { name: /Evidence & Release Dossier Readiness/i })).toBeVisible();

    // Axe accessibility audit on Super Admin Console
    const adminAxe = await new AxeBuilder({ page }).analyze();
    expect(adminAxe.violations).toEqual([]);
  });
});
