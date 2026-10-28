// backend/src/domains/work/pseudonym.ts
import { createHmac } from "node:crypto";

/**
 * Tenant-scoped pseudonym derivation.
 * Uses HMAC-SHA256 with a per-tenant secret key so that:
 * 1. The same person in two different tenants has completely unrelated pseudonyms.
 * 2. The mapping cannot be recomputed without the tenant-specific secret.
 * 3. Identifiable workforce keys are never stored in the work-state ledger.
 */
export function derivePseudonym(tenantSecret: string | Buffer, sourceSubjectRef: string): string {
  const key = typeof tenantSecret === "string" ? Buffer.from(tenantSecret, "utf-8") : tenantSecret;
  return createHmac("sha256", key)
    .update(sourceSubjectRef.normalize("NFC"))
    .digest("base64url");
}

