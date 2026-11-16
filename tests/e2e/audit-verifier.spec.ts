// tests/e2e/audit-verifier.spec.ts
// Browser End-to-End Test for the Zero-Trust Audit Verifier & Merkle Explorer (Phase 9)

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || "http://127.0.0.1:5173";

test.describe("Audit Verifier & Merkle Tree E2E", () => {
  test("verifies clean bundles, issues live backend packages, detects tampering, and supports file upload", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText(/Backend Connected/i)).toBeVisible({ timeout: 15_000 });

    // 1. Open Audit Verifier & Merkle tab
    await page.getByRole("button", { name: /Audit Verifier & Merkle/i }).click();
    await expect(
      page.getByRole("heading", { name: /Cryptographic Evidence Verifier/i })
    ).toBeVisible({ timeout: 10_000 });

    // 2. Initial sample bundle passes WebCrypto SHA-256 + Merkle verification
    await expect(
      page.getByText(/VERIFIED: Manifest Hash, Artifact SHA-256 Digests, and Merkle Root Match/i)
    ).toBeVisible({ timeout: 10_000 });

    // 3. Issue & Verify Live Package via backend /api/v2/evidence-packages
    const issueBtn = page.getByRole("button", { name: /Issue & Verify Live Package/i });
    await expect(issueBtn).toBeEnabled({ timeout: 10_000 });
    await issueBtn.click();
    await expect(page.getByText(/stored packages:/i)).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/VERIFIED: Manifest Hash, Artifact SHA-256 Digests, and Merkle Root Match/i)
    ).toBeVisible();

    // 4. Reload clean sample bundle, then simulate tampering and verify FAIL detection
    await page.getByRole("button", { name: /Load Clean Sample Bundle/i }).click();
    await expect(
      page.getByText(/VERIFIED: Manifest Hash, Artifact SHA-256 Digests, and Merkle Root Match/i)
    ).toBeVisible();

    await page.getByRole("button", { name: /Simulate Artifact Tamper/i }).click();
    await expect(page.getByText(/TAMPER OR MISMATCH DETECTED/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Artifact SHA-256 mismatch/i)).toBeVisible();

    // 5. Upload clean Evidence JSON via file input
    await page.getByRole("button", { name: /Load Clean Sample Bundle/i }).click();
    const cleanJson = await page.locator("textarea").first().inputValue();
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles({
      name: "evidence-bundle.json",
      mimeType: "application/json",
      buffer: Buffer.from(cleanJson, "utf8")
    });
    await expect(
      page.getByText(/VERIFIED: Manifest Hash, Artifact SHA-256 Digests, and Merkle Root Match/i)
    ).toBeVisible();
  });
});
