import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.BASE_URL || process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Login Screen, Sign Out, and Hardened Super Admin Console", () => {
  test("can sign out to Login screen, sign in as Super Admin, exercise step-up, four-eyes, governance, audit export, and pass Axe", async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    const tenantName = `E2E SuperAdmin Corp ${suffix}`;
    const bootstrapSubject = `auth0|e2e-admin-${suffix}@corp.example`;

    await page.goto(BASE_URL);
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // Sign out from initial tenant session
    const signOutBtn = page.getByRole("button", { name: /Sign out/i });
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();

    // Login screen renders cleanly and passes Axe
    await expect(page.getByRole("heading", { name: /Sign in to Zoiko Abate/i })).toBeVisible();
    const loginAxe = await new AxeBuilder({ page }).analyze();
    expect(loginAxe.violations).toEqual([]);

    // Switch to Super Admin tab and sign in
    await page.getByRole("tab", { name: /Super Admin \/ Platform Console/i }).click();
    await page.getByRole("button", { name: /Sign In as Super Admin/i }).click();

    // Super Admin Console loads Platform Overview with mandatory zero-tenant-data banner
    await expect(page.getByText(/ZOIKO ABATE — SUPER ADMIN/i)).toBeVisible();
    await expect(page.getByText(/Platform admin: no tenant business data is shown here\./i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Platform Overview/i })).toBeVisible();

    // Verify Step-Up Re-Authentication via accessible dialog
    await page.getByRole("button", { name: "Verify Step-Up" }).click();
    const stepUpDialog = page.getByRole("dialog", { name: /Step-Up Re-Authentication Required/i });
    await expect(stepUpDialog).toBeVisible();
    await stepUpDialog.getByRole("button", { name: "Verify Step-Up" }).click();
    await expect(page.getByRole("button", { name: "Step-Up Active" })).toBeVisible({ timeout: 10_000 });

    // 1. Tenant Management: create, edit (If-Match), suspend (four-eyes), reactivate, offboard request
    await page.getByRole("button", { name: "Tenant Management" }).click();
    await page.getByLabel("New Tenant Name").fill(tenantName);
    await page.getByRole("button", { name: "Create Tenant" }).click();
    await expect(page.getByText(new RegExp(`Created tenant "${tenantName}"`, "i"))).toBeVisible({ timeout: 10_000 });

    const tenantRow = page.locator("tr", { hasText: tenantName });
    await expect(tenantRow).toBeVisible();

    // Edit tenant metadata
    await tenantRow.getByRole("button", { name: "Edit" }).click();
    await page.locator("#admin-edit-region").fill("uk-london");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Updated metadata for/i)).toBeVisible({ timeout: 10_000 });

    // Suspend tenant -> submits four-eyes approval request (202)
    await tenantRow.getByRole("button", { name: "Suspend" }).click();
    const confirmDialog = page.getByRole("dialog");
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator("#confirm-reason-input").fill("E2E four-eyes suspension drill");
    await confirmDialog.getByRole("button", { name: /Submit Suspension Request/i }).click();
    await expect(page.getByText(/Four-eyes approval request/i)).toBeVisible({ timeout: 10_000 });

    // Self-approval attempt as Admin #1 MUST be refused (403)
    await page.getByRole("button", { name: /Four-Eyes Approvals/i }).click();
    await expect(page.getByRole("heading", { name: /Four-Eyes Approval Queue/i })).toBeVisible();
    const pendingRow = page.locator("tr", { hasText: "E2E four-eyes suspension drill" }).first();
    await expect(pendingRow).toBeVisible();
    await pendingRow.getByRole("button", { name: "Approve" }).click();
    const feSelfDialog = page.getByRole("dialog", { name: /Four-Eyes Approval Confirmation/i });
    await expect(feSelfDialog.getByText(/Self-approval is refused/i)).toBeVisible();
    await feSelfDialog.locator("#foureyes-reason-input").fill("Attempting self approval");
    await feSelfDialog.getByRole("button", { name: "Approve & Execute" }).click();
    await expect(page.getByText(/Four-eyes violation/i)).toBeVisible({ timeout: 10_000 });

    // Switch to Admin #2, verify step-up, and approve the suspension
    await page.getByRole("button", { name: /Switch Super Admin operator/i }).click();
    await expect(page.getByText(/superadmin-2@zoikoabate\.dev/i).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Verify Step-Up" }).click();
    const stepUpDialog2 = page.getByRole("dialog", { name: /Step-Up Re-Authentication Required/i });
    await stepUpDialog2.getByRole("button", { name: "Verify Step-Up" }).click();
    await expect(page.getByRole("button", { name: "Step-Up Active" })).toBeVisible({ timeout: 10_000 });

    const pendingRow2 = page.locator("tr", { hasText: "E2E four-eyes suspension drill" }).first();
    await pendingRow2.getByRole("button", { name: "Approve" }).click();
    const feDialog2 = page.getByRole("dialog", { name: /Four-Eyes Approval Confirmation/i });
    await feDialog2.locator("#foureyes-reason-input").fill("Second distinct admin verified maintenance hold");
    await feDialog2.getByRole("button", { name: "Approve & Execute" }).click();
    await expect(page.getByText(/Executed request/i)).toBeVisible({ timeout: 10_000 });

    // Return to Tenant Management: reactivate & request offboarding
    await page.getByRole("button", { name: "Tenant Management" }).click();
    const suspendedRow = page.locator("tr", { hasText: tenantName });
    await expect(suspendedRow.getByText("SUSPENDED")).toBeVisible();
    await suspendedRow.getByRole("button", { name: "Activate" }).click();
    const actDialog = page.getByRole("dialog");
    await actDialog.locator("#confirm-reason-input").fill("E2E maintenance verification complete");
    await actDialog.getByRole("button", { name: "Reactivate Tenant" }).click();
    await expect(page.getByText(/state is now ACTIVE/i)).toBeVisible({ timeout: 10_000 });

    await suspendedRow.getByRole("button", { name: "Offboard Request" }).click();
    const offDialog = page.getByRole("dialog");
    await offDialog.locator("#confirm-reason-input").fill("E2E contract termination offboard workflow check");
    await offDialog.getByRole("button", { name: /Submit Offboarding Request/i }).click();
    await expect(page.getByText(/queued for offboarding/i)).toBeVisible({ timeout: 10_000 });

    // 2. Platform Users
    await page.getByRole("button", { name: "Platform Users" }).click();
    await expect(page.getByRole("heading", { name: /Platform Staff Accounts/i })).toBeVisible();
    await expect(page.getByText("superadmin@zoikoabate.dev")).toBeVisible();

    // 3. Users & Access (pseudonymous/masked display + EMPLOYER_ADMIN bootstrap + revoke)
    await page.getByRole("button", { name: "Users & Access" }).click();
    await expect(page.getByRole("heading", { name: /Users, Principals & Role Memberships/i })).toBeVisible();
    await page.locator("#admin-user-tenant-select").selectOption({ label: `${tenantName} [uk-london]` });
    await page.locator("#admin-new-subject").fill(bootstrapSubject);
    await page.getByRole("button", { name: "Bootstrap Tenant Admin" }).click();
    await expect(page.getByText(/Bootstrapped EMPLOYER_ADMIN/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(bootstrapSubject)).toHaveCount(0); // Raw subject must be masked!
    await page.getByRole("button", { name: "Revoke" }).first().click();
    const revDialog = page.getByRole("dialog");
    await revDialog.locator("#confirm-reason-input").fill("E2E bootstrap cleanup");
    await revDialog.getByRole("button", { name: "Revoke Membership" }).click();
    await expect(page.getByText(/Revoked EMPLOYER_ADMIN membership/i)).toBeVisible({ timeout: 10_000 });

    // 4. Governance & Flags (preview packs labelled not enabled; flag disable immediate)
    await page.getByRole("button", { name: "Governance & Flags" }).click();
    await expect(page.getByRole("heading", { name: /Governance Packs & Feature Flags/i })).toBeVisible();
    await expect(page.getByText(/preview, not enabled/i).first()).toBeVisible();
    await page.locator("#ff-enabled").selectOption("false");
    await page.getByRole("button", { name: "Submit Flag" }).click();
    await expect(page.getByText(/Set planeBOutcomes = false/i)).toBeVisible({ timeout: 10_000 });

    // 5. Entitlements & AI
    await page.getByRole("button", { name: "Entitlements & AI" }).click();
    await expect(page.getByRole("heading", { name: /Commercial Entitlements & AI Quota Controls/i })).toBeVisible();
    await page.locator("#ent-key").fill("E2E_EXPORT_TIER");
    await page.locator("#ent-reason").fill("E2E commercial entitlement verification");
    await page.getByRole("button", { name: "Set Entitlement" }).click();
    await expect(page.getByText(/Updated entitlement E2E_EXPORT_TIER/i)).toBeVisible({ timeout: 10_000 });

    // 6. Worker & Kill Switches (four-eyes kill switch request with mandatory reason)
    await page.getByRole("button", { name: "Worker & Kill Switches" }).click();
    await expect(page.getByRole("heading", { name: /Platform Operations, Kill Switches/i })).toBeVisible();
    await page.locator("#ks-scope").selectOption("use_case:DRAFT_CAUSE");
    await page.locator("#ks-active").selectOption("false");
    await page.getByRole("button", { name: "Request Kill Switch" }).click();
    const ksDialog = page.getByRole("dialog");
    await ksDialog.locator("#confirm-reason-input").fill("E2E governed kill switch audit test");
    await ksDialog.getByRole("button", { name: /Submit Kill Switch Request/i }).click();
    await expect(page.getByText(/queued for kill switch/i)).toBeVisible({ timeout: 10_000 });

    // 7. Platform Audit (audited JSON export)
    await page.getByRole("button", { name: "Platform Audit" }).click();
    await expect(page.getByRole("heading", { name: /Immutable Platform Audit Log/i })).toBeVisible();
    await page.getByRole("button", { name: "Export JSON (Audited)" }).click();
    const expDialog = page.getByRole("dialog");
    await expDialog.locator("#confirm-reason-input").fill("E2E quarterly audit export check");
    await expDialog.getByRole("button", { name: "Export JSON" }).click();
    await expect(page.getByText(/Exported platform audit log \(JSON\)/i)).toBeVisible({ timeout: 10_000 });

    // 8. Evidence & Dossier (strictly read-only — ZERO Ratify button)
    await page.getByRole("button", { name: "Evidence & Dossier" }).click();
    await expect(page.getByRole("heading", { name: /Evidence & Release Dossier Readiness/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /ratify/i })).toHaveCount(0);

    // Axe accessibility audit on Super Admin Console
    const adminAxe = await new AxeBuilder({ page }).analyze();
    expect(adminAxe.violations).toEqual([]);
  });
});
