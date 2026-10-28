// backend/src/domains/ingest/connections.ts
import { withTenant } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { deriveConnectionHealth, ConnectionHealth } from "./freshness";
import { AuthenticatedIdentity, authorize } from "../tenant/auth";
import { Actor } from "../../platform/command";

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

export async function listConnections(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}): Promise<EnrichedConnection[]> {
  authorize(args.actor, "connection.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(`SELECT * FROM connection`);
    const now = new Date();

    return res.rows.map(row => ({
      ...row,
      health: deriveConnectionHealth({
        lastSuccessAt: row.last_success_at,
        expectedCadenceSeconds: row.expected_cadence_seconds
      }, now)
    }));
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

    const row = res.rows[0];
    return {
      ...row,
      health: deriveConnectionHealth({
        lastSuccessAt: row.last_success_at,
        expectedCadenceSeconds: row.expected_cadence_seconds
      }, new Date())
    };
  });
}

export async function setConnectionState(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  connectionId: string;
  newState: "ACTIVE" | "PAUSED" | "REVOKED";
}): Promise<EnrichedConnection> {
  authorize(args.actor, "connection.admin");

  return withTenant(args.who.tenantId, async (tx) => {
    const updateRes = await tx.q(
      `UPDATE connection SET state = $1 WHERE id = $2`,
      [args.newState, args.connectionId]
    );

    if (updateRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Not found.");
    }

    const row = updateRes.rows[0];
    return {
      ...row,
      health: deriveConnectionHealth({
        lastSuccessAt: row.last_success_at,
        expectedCadenceSeconds: row.expected_cadence_seconds
      }, new Date())
    };
  });
}

export async function listReceipts(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}) {
  authorize(args.actor, "receipt.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(`SELECT * FROM ingest_receipt ORDER BY received_at DESC`);
    return res.rows;
  });
}

export async function listWorkFacts(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}) {
  authorize(args.actor, "work_fact.read");

  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(`SELECT * FROM work_fact_revision ORDER BY recorded_at DESC`);
    return res.rows;
  });
}

