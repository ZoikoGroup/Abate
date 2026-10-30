// backend/tools/reconcile-after-restore.ts
// Restore Reconciliation Runbook (Playbook B5 §4 Step 10)
// Prevents backup restores from resurrecting deleted records.

export interface TombstoneLogEntry {
  tenantId: string;
  recordRef: string;
  recordKeyDigest: string;
  deletedAt: string;
  basis: string;
}

export interface RestoredDatabase {
  workFacts: Map<string, { id: string; tenant_id: string; source_record_id: string }>;
  tombstones: Map<string, TombstoneLogEntry>;
}

/**
 * reconcileAfterRestore: Re-applies external tombstone log to a restored snapshot
 * to guarantee that deleted records cannot resurrect after backup restoration.
 */
export function reconcileAfterRestore(
  restoredDb: RestoredDatabase,
  productionTombstoneLog: TombstoneLogEntry[]
): {
  reconciledDeletions: number;
  survivingFactsCount: number;
} {
  let reconciled = 0;

  for (const t of productionTombstoneLog) {
    // 1. Re-add tombstone to restored state
    restoredDb.tombstones.set(t.recordRef, t);

    // 2. If the restored DB resurrected the deleted work fact, purge it immediately
    if (restoredDb.workFacts.has(t.recordRef)) {
      restoredDb.workFacts.delete(t.recordRef);
      reconciled++;
    }
  }

  return {
    reconciledDeletions: reconciled,
    survivingFactsCount: restoredDb.workFacts.size
  };
}
