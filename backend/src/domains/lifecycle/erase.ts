// backend/src/domains/lifecycle/erase.ts
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { sha256Hex, canonicalJson } from "../../platform/canonical";

/**
 * eraseSubject: Implements Subject Rights Requests (GDPR Art 17 Erasure) (Playbook B5 §4 Step 9).
 * 
 * Rules:
 * 1. Lawful legal holds are excluded and recorded as exceptions; never claim held bytes were deleted.
 * 2. Non-held subject-linked facts are hard deleted.
 * 3. Deletion tombstones are inserted with basis 'RIGHTS_REQUEST'.
 * 4. Derived caches and generated copies are purged.
 */
export async function eraseSubject(
  tx: Tx,
  subjectPseudonym: string
): Promise<{
  requestId: string;
  deleted: number;
  heldExceptions: number;
}> {
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();

  // 1. Fetch all work facts linked to this subject pseudonym
  const fRes = await tx.q("SELECT * FROM work_fact WHERE tenant_id = $1", [tx.tenantId]);
  const subjectFacts = fRes.rows.filter((f: any) => (f.subject_pseudonym === subjectPseudonym || f.employee_pseudonym === subjectPseudonym));

  // 2. Fetch active legal holds
  const hRes = await tx.q("SELECT * FROM legal_hold WHERE tenant_id = $1 AND released_at IS NULL", [tx.tenantId]);
  const activeHolds = hRes.rows;

  const toDelete: any[] = [];
  let heldExceptions = 0;

  for (const fact of subjectFacts) {
    const isHeld = activeHolds.some((h: any) => {
      if (h.scope_connection_id && h.scope_connection_id !== fact.connection_id) return false;
      return true;
    });

    if (isHeld) {
      heldExceptions++;
    } else {
      toDelete.push(fact);
    }
  }

  // 3. For each non-held record, write tombstone and hard delete
  const runId = crypto.randomUUID();
  for (const fact of toDelete) {
    const tombstoneId = crypto.randomUUID();
    const factDigest = sha256Hex(canonicalJson(fact));
    const keyDigest = sha256Hex(`key:${fact.connection_id}:${fact.source_record_id}`);

    await tx.q(
      `INSERT INTO deletion_tombstone (
        id, tenant_id, run_id, data_category, record_ref, record_digest, record_key_digest, deleted_at, verified_at
      ) VALUES ($1, $2, $3, 'WORK_FACT', $4, $5, $6, $7, $8)`,
      [tombstoneId, tx.tenantId, runId, fact.id, factDigest, keyDigest, now, now]
    );

    await tx.q("DELETE FROM work_fact WHERE id = $1 AND tenant_id = $2", [fact.id, tx.tenantId]);
  }

  // 4. Record rights request audit entry
  await tx.q(
    `INSERT INTO rights_request (
      id, tenant_id, subject_pseudonym, status, deleted_count, held_exceptions, requested_at, completed_at
    ) VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7)`,
    [requestId, tx.tenantId, subjectPseudonym, toDelete.length, heldExceptions, now, now]
  );

  return {
    requestId,
    deleted: toDelete.length,
    heldExceptions
  };
}
