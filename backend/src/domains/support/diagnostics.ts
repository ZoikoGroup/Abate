// backend/src/domains/support/diagnostics.ts
import crypto from "node:crypto";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { AppError } from "../../platform/errors";
import { loadConfig } from "../../platform/config";
import { canonicalJson } from "../../platform/canonical";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { deriveConnectionHealth, ConnectionHealth } from "../ingest/freshness";
import { resolveTenantCoverage } from "../lifecycle/jurisdiction";

const cfg = loadConfig();
const SIGNING_KEY = `${cfg.authSecret}:diagnostic-receipts`;

export const DIAGNOSTIC_SCHEMA = "abate.diagnostic-receipt.v1";

// Stated in every receipt so the recipient knows what was deliberately left out
export const DIAGNOSTIC_EXCLUSIONS = [
  "work fact rows and intervals",
  "subject pseudonyms",
  "principal identities",
  "released metric values",
  "request and payload content"
];

export interface DiagnosticSections {
  connections: Array<{ connectionRef: string; source: string; state: string; health: ConnectionHealth }>;
  ingest: {
    receipts: number;
    lastReceivedAt: string | null;
    lastCounts: { accepted: number; duplicate: number; rejected: number; conflicted: number } | null;
  };
  outbox: { pendingEvents: number };
  privacyReleases: Record<string, number>;
  retention: {
    coverage: "COVERED" | "NOT_COVERED";
    packRef: string | null;
    activeClassDays: number | null;
    activeLegalHolds: number;
    lastRunStatus: string | null;
  };
}

export interface DiagnosticReceipt {
  receiptId: string;
  schemaVersion: typeof DIAGNOSTIC_SCHEMA;
  tenantId: string;
  generatedAt: string;
  sections: DiagnosticSections;
  excluded: string[];
  signature: string;
}

function sign(body: Omit<DiagnosticReceipt, "signature">): string {
  return crypto.createHmac("sha256", SIGNING_KEY).update(canonicalJson(body)).digest("hex");
}

const latest = <T>(rows: T[], key: (r: T) => string | Date): T | undefined =>
  [...rows].sort((a, b) => +new Date(key(b)) - +new Date(key(a)))[0];

/**
 * Tenant-initiated health snapshot for support: states and counts only, server-signed so the
 * support operator can trust it without querying the tenant's data.
 */
export async function generateDiagnosticReceipt(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  idempotencyKey: string | null | undefined;
}) {
  authorize(args.actor, "support.diagnostic.generate");
  if (!args.idempotencyKey) {
    throw new AppError("VALIDATION", "Header 'Idempotency-Key' is required for all state-changing commands.");
  }

  return runCommand<DiagnosticReceipt>({
    tenantId: args.who.tenantId,
    operation: "support.diagnostic.generate",
    idempotencyKey: args.idempotencyKey,
    requestHash: computeRequestHash({ operation: "support.diagnostic.generate" }),
    actor: args.actor,
    body: async (tx) => {
      const now = new Date();
      const connections = (await tx.q(`SELECT * FROM connection`)).rows;
      const receipts = (await tx.q(`SELECT * FROM ingest_receipt`)).rows;
      const pending = (await tx.q(`SELECT * FROM outbox_event WHERE published_at IS NULL`)).rows
        .filter((e: any) => e.tenant_id === tx.tenantId);
      const releases = (await tx.q(`SELECT * FROM privacy_release`)).rows;
      const classes = (await tx.q(`SELECT * FROM retention_class`)).rows;
      const holds = (await tx.q(`SELECT * FROM legal_hold`)).rows;
      const runs = (await tx.q(`SELECT * FROM retention_run`)).rows;
      const { coverage } = await resolveTenantCoverage(tx, now);

      const lastReceipt = latest(receipts, (r: any) => r.received_at);
      const lastRun = latest(runs, (r: any) => r.completed_at);
      const activeClass = classes.find((c: any) => c.status === "ACTIVE");

      const sections: DiagnosticSections = {
        connections: connections.map((c: any) => ({
          connectionRef: c.id,
          source: c.source,
          state: c.state,
          health: deriveConnectionHealth({ lastSuccessAt: c.last_success_at, expectedCadenceSeconds: c.expected_cadence_seconds }, now)
        })),
        ingest: {
          receipts: receipts.length,
          lastReceivedAt: lastReceipt ? new Date(lastReceipt.received_at).toISOString() : null,
          lastCounts: lastReceipt
            ? { accepted: lastReceipt.accepted, duplicate: lastReceipt.duplicate, rejected: lastReceipt.rejected, conflicted: lastReceipt.conflicted }
            : null
        },
        outbox: { pendingEvents: pending.length },
        privacyReleases: releases.reduce((acc: Record<string, number>, r: any) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {}),
        retention: {
          coverage: coverage.status,
          packRef: coverage.status === "COVERED" ? `${coverage.pack.packKey}@v${coverage.pack.version}` : null,
          activeClassDays: activeClass?.retention_days ?? null,
          activeLegalHolds: holds.filter((h: any) => !h.released_at).length,
          lastRunStatus: lastRun?.status ?? null
        }
      };

      const body: Omit<DiagnosticReceipt, "signature"> = {
        receiptId: crypto.randomUUID(),
        schemaVersion: DIAGNOSTIC_SCHEMA,
        tenantId: tx.tenantId,
        generatedAt: now.toISOString(),
        sections,
        excluded: [...DIAGNOSTIC_EXCLUSIONS]
      };
      const receipt: DiagnosticReceipt = { ...body, signature: sign(body) };

      return {
        result: receipt,
        audit: {
          purpose: args.who.purpose,
          command: "support.diagnostic.generate",
          resourceType: "diagnostic_receipt",
          resourceId: receipt.receiptId,
          result: "SUCCESS" as const,
          evidenceRefs: [`diagnostic_receipt/${receipt.receiptId}`]
        },
        events: [{
          aggregate: "diagnostic_receipt",
          aggregateId: receipt.receiptId,
          aggregateVersion: 1,
          eventType: "support.diagnostic.generated",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`diagnostic_receipt/${receipt.receiptId}`]
        }]
      };
    }
  });
}

/**
 * Support-side integrity check: a receipt edited after issue (or forged) fails verification.
 */
export function verifyDiagnosticReceipt(input: unknown): { valid: boolean; receiptId: string | null; tenantId: string | null; generatedAt: string | null } {
  const r = input as Partial<DiagnosticReceipt> | null;
  const invalid = { valid: false, receiptId: null, tenantId: null, generatedAt: null };
  if (!r || typeof r !== "object" || typeof r.signature !== "string" || !/^[0-9a-f]{64}$/.test(r.signature)) {
    return invalid;
  }

  const { signature, ...body } = r as DiagnosticReceipt;
  const expected = Buffer.from(sign(body), "hex");
  const given = Buffer.from(signature, "hex");
  if (!crypto.timingSafeEqual(expected, given)) {
    return invalid;
  }
  return { valid: true, receiptId: body.receiptId, tenantId: body.tenantId, generatedAt: body.generatedAt };
}
