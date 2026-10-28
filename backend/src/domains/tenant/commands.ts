// backend/src/domains/tenant/commands.ts
import crypto from "node:crypto";
import { runCommand, computeRequestHash, Actor } from "../../platform/command";
import { withTenant } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { AuthenticatedIdentity, authorize } from "./auth";
import { CreateOrganizationBodyType } from "../../contracts/tenant";

export interface CreateOrgArgs {
  who: AuthenticatedIdentity;
  actor: Actor;
  body: CreateOrganizationBodyType;
  idempotencyKey: string;
}

export async function createOrganization(args: CreateOrgArgs) {
  authorize(args.actor, "organization.create");

  const orgId = crypto.randomUUID();
  const requestHash = computeRequestHash(args.body);

  return runCommand({
    tenantId: args.who.tenantId,
    operation: "organization.create",
    idempotencyKey: args.idempotencyKey,
    requestHash,
    actor: args.actor,
    body: async (tx) => {
      // 1. Mutate organization table
      await tx.q(
        `INSERT INTO organization (id, tenant_id, parent_id, name)
         VALUES ($1, $2, $3, $4)`,
        [orgId, tx.tenantId, args.body.parentId || null, args.body.name]
      );

      const result = {
        id: orgId,
        tenantId: tx.tenantId,
        parentId: args.body.parentId || null,
        name: args.body.name,
        createdAt: new Date().toISOString()
      };

      // 2. Audit + Outbox within the SAME transaction
      const audit = {
        purpose: args.who.purpose,
        command: "organization.create",
        resourceType: "organization",
        resourceId: orgId,
        resourceVersion: 1,
        result: "SUCCESS" as const,
        evidenceRefs: [`org-create-${orgId}`]
      };

      const events = [
        {
          aggregate: "organization",
          aggregateId: orgId,
          aggregateVersion: 1,
          eventType: "organization.created",
          schemaVersion: "v1.0",
          purpose: args.who.purpose,
          refs: [`organization/${orgId}`]
        }
      ];

      return { result, audit, events };
    }
  });
}

export async function getOrganization(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
  orgId: string;
}) {
  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(
      `SELECT id, tenant_id, parent_id, name FROM organization WHERE id = $1`,
      [args.orgId]
    );

    // Fail safe: foreign tenant or non-existent ID both yield safe 404 NOT_FOUND
    if (res.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Not found.");
    }

    return res.rows[0];
  });
}

export async function listOrganizations(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}) {
  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(
      `SELECT id, tenant_id, parent_id, name FROM organization`
    );
    return res.rows;
  });
}

export async function getTenant(args: {
  who: AuthenticatedIdentity;
  actor: Actor;
}) {
  return withTenant(args.who.tenantId, async (tx) => {
    const res = await tx.q(
      `SELECT id, name, region, jurisdiction_config_ref, created_at FROM tenant WHERE id = $1`,
      [args.who.tenantId]
    );
    if (res.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Tenant not found.");
    }
    return res.rows[0];
  });
}

