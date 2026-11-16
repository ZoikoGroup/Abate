// backend/src/domains/ingest/connections.ts
import crypto from "node:crypto";
import { withTenant } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { deriveConnectionHealth, ConnectionHealth } from "./freshness";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { Actor, computeRequestHash, runCommand } from "../../platform/command";
import { CreateConnectionInput } from "../../contracts/ingest";

export interface EnrichedConnection {
  id: string;
  tenant_id: string;
  source: string;
  contract_id: string;
  state: "ACTIVE" | "PAUSED" | "REVOKED";
  last_success_at: string | null;
  expected_cadence_seconds: number;
  health: ConnectionHealth;
}

export interface SourceContractSummary {
  id: string;
  tenant_id: string;
  source: string;
  version: string;
  contract_hash: string;
  status: string;
}

function enrichConnectionRow(row: any, now: Date): EnrichedConnection {
  return {
    ...row,
    health: deriveConnectionHealth(
      {
        lastSuccessAt: row.last_success_at,
        expectedCadenceSeconds: row.expected_cadence_seconds
      },
      now
    )
  };
}

export async function listSourceContracts(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}): Promise<SourceContractSummary[]> {
  authorize(args.actor, "connection.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(`SELECT * FROM source_contract ORDER BY source ASC, version DESC`);
    return res.rows;
  });
}

export async function listConnections(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}): Promise<EnrichedConnection[]> {
  authorize(args.actor, "connection.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(`SELECT * FROM connection`);
    const now = new Date();

    return res.rows.map(row => enrichConnectionRow(row, now));
  });
}

export async function getConnection(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  connectionId: string;
}): Promise<EnrichedConnection> {
  authorize(args.actor, "connection.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(`SELECT * FROM connection WHERE id = $1`, [args.connectionId]);
    if (res.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Not found.");
    }

    return enrichConnectionRow(res.rows[0], new Date());
  });
}

export async function registerConnection(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  input: CreateConnectionInput;
  idempotencyKey: string;
}): Promise<{ status: number; body: EnrichedConnection }> {
  authorize(args.actor, "connection.admin");

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "connection.register",
    idempotencyKey: args.idempotencyKey,
    requestHash: computeRequestHash(args.input),
    actor: args.actor,
    body: async (tx) => {
      const contractRes = await tx.q(
        `SELECT id, source, version, status FROM source_contract WHERE id = $1`,
        [args.input.contractId]
      );
      if (contractRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Source contract not found.");
      }

      const contract = contractRes.rows[0];
      if (contract.status !== "ACTIVE") {
        throw new AppError("CONFLICT", `Source contract is '${contract.status}' and cannot be bound.`);
      }
      if (String(contract.source).toLowerCase() !== args.input.source.toLowerCase()) {
        throw new AppError(
          "VALIDATION",
          `Contract source '${contract.source}' does not match requested adapter '${args.input.source}'.`
        );
      }

      const connId = crypto.randomUUID();
      const insRes = await tx.q(
        `INSERT INTO connection (id, tenant_id, source, contract_id, state, expected_cadence_seconds)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [connId, tx.tenantId, args.input.source, args.input.contractId, "ACTIVE", args.input.expectedCadenceSeconds]
      );

      const enriched = enrichConnectionRow(insRes.rows[0], new Date());

      return {
        result: enriched,
        audit: {
          purpose: args.who.purpose,
          command: "connection.register",
          resourceType: "connection",
          resourceId: connId,
          resourceVersion: 1,
          result: "SUCCESS",
          evidenceRefs: [`connection/${connId}`, `contract/${args.input.contractId}`]
        },
        events: [
          {
            aggregate: "connection",
            aggregateId: connId,
            aggregateVersion: 1,
            eventType: "connection.registered",
            schemaVersion: "v1.0",
            purpose: args.who.purpose,
            refs: [`connection/${connId}`, `source/${args.input.source}`]
          }
        ]
      };
    }
  });
}

export async function setConnectionState(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  connectionId: string;
  newState: "ACTIVE" | "PAUSED" | "REVOKED";
  idempotencyKey?: string;
}): Promise<{ status: number; body: EnrichedConnection }> {
  authorize(args.actor, "connection.admin");

  const key = args.idempotencyKey || `conn-state:${args.connectionId}:${args.newState}:${crypto.randomUUID()}`;
  const requestHash = computeRequestHash({
    connectionId: args.connectionId,
    newState: args.newState
  });

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "connection.state_change",
    idempotencyKey: key,
    requestHash,
    actor: args.actor,
    body: async (tx) => {
      const existingRes = await tx.q(
        `SELECT * FROM connection WHERE id = $1`,
        [args.connectionId]
      );
      if (existingRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Not found.");
      }

      const existing = existingRes.rows[0];
      if (existing.state === "REVOKED") {
        throw new AppError(
          "CONFLICT",
          "REVOKED connection is terminal and cannot transition to another state."
        );
      }

      const updateRes = await tx.q(
        `UPDATE connection SET state = $1 WHERE id = $2 RETURNING *`,
        [args.newState, args.connectionId]
      );

      if (updateRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Not found.");
      }

      const enriched = enrichConnectionRow(updateRes.rows[0], new Date());

      return {
        result: enriched,
        audit: {
          purpose: args.who.purpose,
          command: "connection.state_change",
          resourceType: "connection",
          resourceId: args.connectionId,
          resourceVersion: 1,
          result: "SUCCESS",
          evidenceRefs: [`connection/${args.connectionId}`, `state/${args.newState}`]
        },
        events: [
          {
            aggregate: "connection",
            aggregateId: args.connectionId,
            aggregateVersion: 1,
            eventType: "connection.state_changed",
            schemaVersion: "v1.0",
            purpose: args.who.purpose,
            refs: [
              `connection/${args.connectionId}`,
              `from/${existing.state}`,
              `to/${args.newState}`
            ]
          }
        ]
      };
    }
  });
}

// List endpoints are bounded: default 200, ceiling 1000 (these are the largest tables in the system)
function clampLimit(n?: number): number {
  return Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, 1000) : 200;
}

export async function listReceipts(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  limit?: number;
}) {
  authorize(args.actor, "receipt.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const limit = clampLimit(args.limit);
    const res = await tx.q(`SELECT * FROM ingest_receipt ORDER BY received_at DESC LIMIT ${limit}`);
    return res.rows.slice(0, limit);
  });
}

export async function listWorkFacts(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  limit?: number;
}) {
  authorize(args.actor, "work_fact.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const limit = clampLimit(args.limit);
    const res = await tx.q(`SELECT * FROM work_fact_revision ORDER BY recorded_at DESC LIMIT ${limit}`);
    return res.rows.slice(0, limit);
  });
}

