// backend/src/domains/aichange/profile.ts
// AI Change Profile registration (Phase 7 / Domain S14)
import crypto from "node:crypto";
import { Tx } from "../../platform/db/with-tenant";
import { AppError } from "../../platform/errors";
import { Actor } from "../../platform/command";
import {
  CreateAiChangeProfileInput,
  AiChangeProfileView
} from "../../contracts/aichange";

/**
 * registerAiChangeProfile: Registers a new versioned AI change profile.
 */
export async function registerAiChangeProfile(
  tx: Tx,
  actor: Actor,
  input: CreateAiChangeProfileInput
): Promise<AiChangeProfileView> {
  const id = crypto.randomUUID();
  const version = 1;

  await tx.q(
    `INSERT INTO ai_change_profile (
      id, tenant_id, title, version, affected_roles, affected_tasks,
      automation_mode, decision_rights, human_override, monitoring_changes,
      throughput_assumptions, rollout_date, training_support
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      actor.tenantId,
      input.title,
      version,
      input.affectedRoles,
      input.affectedTasks,
      input.automationMode,
      input.decisionRights,
      input.humanOverride,
      input.monitoringChanges,
      input.throughputAssumptions,
      input.rolloutDate,
      input.trainingSupport
    ]
  );

  return {
    id,
    tenantId: actor.tenantId,
    title: input.title,
    version,
    affectedRoles: input.affectedRoles,
    affectedTasks: input.affectedTasks,
    automationMode: input.automationMode,
    decisionRights: input.decisionRights,
    humanOverride: input.humanOverride,
    monitoringChanges: input.monitoringChanges,
    throughputAssumptions: input.throughputAssumptions,
    rolloutDate: input.rolloutDate,
    trainingSupport: input.trainingSupport
  };
}

/**
 * getAiChangeProfile: Fetches an AI change profile by id and version.
 */
export async function getAiChangeProfile(
  tx: Tx,
  tenantId: string,
  id: string,
  version = 1
): Promise<AiChangeProfileView> {
  const res = await tx.q(
    `SELECT * FROM ai_change_profile WHERE id = $1 AND tenant_id = $2 AND version = $3`,
    [id, tenantId, version]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new AppError("NOT_FOUND", `AI Change Profile '${id}' v${version} not found.`);
  }
  const r = res.rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    version: r.version,
    affectedRoles: Array.isArray(r.affected_roles) ? r.affected_roles : JSON.parse(r.affected_roles || "[]"),
    affectedTasks: Array.isArray(r.affected_tasks) ? r.affected_tasks : JSON.parse(r.affected_tasks || "[]"),
    automationMode: r.automation_mode,
    decisionRights: r.decision_rights,
    humanOverride: r.human_override,
    monitoringChanges: r.monitoring_changes,
    throughputAssumptions: r.throughput_assumptions,
    rolloutDate: r.rollout_date,
    trainingSupport: r.training_support
  };
}

/**
 * listAiChangeProfiles: Lists AI change profiles for tenant.
 */
export async function listAiChangeProfiles(
  tx: Tx,
  tenantId: string
): Promise<AiChangeProfileView[]> {
  const res = await tx.q(
    `SELECT * FROM ai_change_profile WHERE tenant_id = $1 ORDER BY title ASC, version DESC`,
    [tenantId]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    version: r.version,
    affectedRoles: Array.isArray(r.affected_roles) ? r.affected_roles : JSON.parse(r.affected_roles || "[]"),
    affectedTasks: Array.isArray(r.affected_tasks) ? r.affected_tasks : JSON.parse(r.affected_tasks || "[]"),
    automationMode: r.automation_mode,
    decisionRights: r.decision_rights,
    humanOverride: r.human_override,
    monitoringChanges: r.monitoring_changes,
    throughputAssumptions: r.throughput_assumptions,
    rolloutDate: r.rollout_date,
    trainingSupport: r.training_support
  }));
}
