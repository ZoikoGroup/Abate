// tests/e2e/tenant-admin.spec.ts
// End-to-End verification of the Tenant Admin console (/api/v2/tenant-admin/* + tenant routes):
// - Effective-dated role assignment, end membership, deactivate/reactivate user
// - OIDC invitation create (masked email) & revoke
// - Organization unit create & edit (If-Match)
// - Connection register, Suspend, Resume, Disconnect permanently (confirm dialog)
// - Sector Settings (preview packs strictly disabled)
// - Data Lifecycle (placeholder retention notice, legal hold place/release, rights request)
// - Searchable Own Audit Log & Usage/Quotas
// - WCAG 2.1 AA Axe check (0 serious/critical violations)

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.BASE_URL || process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Tenant Admin Workspace E2E & Accessibility", () => {
  test("EMPLOYER_ADMIN manages users, invites, orgs, connections, sector preview lock, lifecycle, audit, usage, and passes Axe", async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    const userSubject = `auth0|e2e-ta-user-${suffix}`;
    const orgName = `E2E Admin Unit ${suffix}`;
    const renamedOrgName = `E2E Admin Unit Renamed ${suffix}`;

    await page.goto(BASE_URL);
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // Switch role to EMPLOYER_ADMIN so Tenant Admin mutation controls are enabled
    const roleSelect = page.getByLabel(/Effective Domain Role:/i);
    const tokPromise = page.waitForResponse((r) => r.url().includes("/api/v2/auth/token") && r.request().method() === "POST");
    await roleSelect.selectOption("EMPLOYER_ADMIN");
    expect((await tokPromise).status()).toBe(200);

    // Open Tenant Admin tab
    await page.locator("nav.tabs-navigation").getByRole("button", { name: "Tenant Admin", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Tenant Admin Console/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/TENANT ISOLATED \(FORCE RLS\)/i)).toBeVisible();

    // 1. Users & Roles: assign effective-dated REVIEWER, end role, deactivate & reactivate
    await page.locator("#ta-role-subject").fill(userSubject);
    await page.locator("#ta-role-name").selectOption("REVIEWER");
    await page.locator("#ta-role-reason").fill("E2E reviewer onboarding");
    await page.getByRole("button", { name: "Assign Role" }).click();
    await expect(page.getByText(new RegExp(`Assigned REVIEWER to ${userSubject.replace("|", "\\|")}`, "i"))).toBeVisible({ timeout: 10_000 });

    const userRow = page.locator("tr", { hasText: userSubject });
    await expect(userRow).toBeVisible();
    await userRow.getByRole("button", { name: "End Role" }).click();
    const endDialog = page.getByRole("dialog");
    await endDialog.locator("#confirm-reason-input").fill("E2E end role verification");
    await endDialog.getByRole("button", { name: "End Membership" }).click();
    await expect(page.getByText(/Ended REVIEWER/i)).toBeVisible({ timeout: 10_000 });

    await userRow.getByRole("button", { name: "Deactivate" }).click();
    const deactDialog = page.getByRole("dialog");
    await deactDialog.locator("#confirm-reason-input").fill("E2E leave of absence");
    await deactDialog.getByRole("button", { name: "Deactivate User" }).click();
    await expect(page.getByText(/is now DEACTIVATED/i)).toBeVisible({ timeout: 10_000 });

    await userRow.getByRole("button", { name: "Reactivate" }).click();
    const reactDialog = page.getByRole("dialog");
    await reactDialog.locator("#confirm-reason-input").fill("E2E returned to role");
    await reactDialog.getByRole("button", { name: "Reactivate User" }).click();
    await expect(page.getByText(/is now ACTIVE/i)).toBeVisible({ timeout: 10_000 });

    // 2. OIDC Invitations: send & revoke
    await page.getByRole("tab", { name: "OIDC Invitations" }).click();
    await page.locator("#inv-email").fill(`e2e.invite.${suffix}@apex.example`);
    await page.locator("#inv-reason").fill("E2E OIDC invitation test");
    await page.getByRole("button", { name: "Send OIDC Invite" }).click();
    await expect(page.getByText(/Created OIDC invitation/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Revoke" }).first().click();
    const invRevDialog = page.getByRole("dialog");
    await invRevDialog.locator("#confirm-reason-input").fill("E2E revoke invitation check");
    await invRevDialog.getByRole("button", { name: "Revoke Invitation" }).click();
    await expect(page.getByText(/Revoked OIDC invitation/i)).toBeVisible({ timeout: 10_000 });

    // 3. Organization Structure: create & rename
    await page.getByRole("tab", { name: "Organization Structure" }).click();
    await page.locator("#ta-org-name").fill(orgName);
    await page.getByRole("button", { name: "Create Unit" }).click();
    await expect(page.getByText(new RegExp(`Created unit "${orgName}"`, "i"))).toBeVisible({ timeout: 10_000 });

    const orgRow = page.locator("tr", { hasText: orgName });
    await orgRow.getByRole("button", { name: "Edit" }).click();
    await page.locator("#ta-edit-org-name").fill(renamedOrgName);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(new RegExp(`Updated organization "${renamedOrgName}"`, "i"))).toBeVisible({ timeout: 10_000 });

    // 4. Connections: register fresh connection, suspend, resume, disconnect permanently (confirm dialog)
    await page.getByRole("tab", { name: "Connections" }).click();
    await page.getByRole("button", { name: "Register Connection" }).click();
    await expect(page.getByText(/Registered .* connection/i)).toBeVisible({ timeout: 10_000 });

    // Operate on the last registered connection row so seeded primary connection remains untouched
    const lastConnRow = page.locator("table.data-table tbody tr").last();
    await lastConnRow.getByRole("button", { name: "Suspend" }).click();
    const suspDialog = page.getByRole("dialog");
    await suspDialog.locator("#confirm-reason-input").fill("E2E temporary connection pause");
    await suspDialog.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByText(/transitioned via suspend/i)).toBeVisible({ timeout: 10_000 });

    await lastConnRow.getByRole("button", { name: "Resume" }).click();
    const resDialog = page.getByRole("dialog");
    await resDialog.locator("#confirm-reason-input").fill("E2E connection resume");
    await resDialog.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText(/transitioned via resume/i)).toBeVisible({ timeout: 10_000 });

    await lastConnRow.getByRole("button", { name: "Disconnect Permanently" }).click();
    const discDialog = page.getByRole("dialog");
    await discDialog.locator("#confirm-reason-input").fill("E2E permanent disconnect confirmation");
    await discDialog.getByRole("button", { name: "Disconnect Permanently" }).click();
    await expect(page.getByText(/transitioned via disconnect/i)).toBeVisible({ timeout: 10_000 });

    // 5. Sector Settings: verify preview packs are disabled
    await page.getByRole("tab", { name: "Sector Settings" }).click();
    await expect(page.getByRole("heading", { name: /Sector Vocabulary & Demand Windows/i })).toBeVisible();
    await expect(page.locator('#sector-pack-select option[value="HEALTHCARE"]')).toBeDisabled();
    await expect(page.locator('#sector-pack-select option[value="SOFTWARE_IT"]')).toBeDisabled();

    // 6. Data Lifecycle: placeholder notice, legal hold place/release, rights request
    await page.getByRole("tab", { name: "Data Lifecycle" }).click();
    await expect(page.getByText(/Placeholder Retention Notice/i)).toBeVisible();
    await page.locator("#ta-hold-ref").fill(`E2E-HOLD-${suffix}`);
    await page.locator("#ta-hold-reason").fill("E2E litigation preservation hold");
    await page.getByRole("button", { name: "Place Hold" }).click();
    await expect(page.getByText(new RegExp(`Placed legal hold for reference E2E-HOLD-${suffix}`, "i"))).toBeVisible({ timeout: 10_000 });

    const holdRow = page.locator("tr", { hasText: `E2E-HOLD-${suffix}` });
    await holdRow.getByRole("button", { name: "Release Hold" }).click();
    const relHoldDialog = page.getByRole("dialog");
    await relHoldDialog.locator("#confirm-reason-input").fill("E2E hold release verification");
    await relHoldDialog.getByRole("button", { name: "Release Hold" }).click();
    await expect(page.getByText(/Released legal hold/i)).toBeVisible({ timeout: 10_000 });

    await page.locator("#ta-rr-psn").fill(`psn-e2e-${suffix}`);
    await page.getByRole("button", { name: "Submit Erasure Request" }).click();
    await expect(page.getByText(/Submitted erasure rights request/i)).toBeVisible({ timeout: 10_000 });

    // 7. Own Audit Log (searchable)
    await page.getByRole("tab", { name: "Own Audit Log" }).click();
    await page.locator("#ta-audit-cmd").fill("tenant.invitation");
    await page.getByRole("button", { name: "Search Own Audit" }).click();
    await expect(page.getByText(/Found \d+ audit event/i)).toBeVisible({ timeout: 10_000 });

    // 8. Usage & Quotas
    await page.getByRole("tab", { name: "Usage & Quotas" }).click();
    await expect(page.getByText(/AI Monthly Budget Cap/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connector Freshness", exact: true })).toBeVisible();

    // WCAG 2.1 AA Axe Accessibility Check
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const severe = axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
    expect(severe).toEqual([]);
  });
});
