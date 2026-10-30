// backend/src/contracts/actions.ts
import { z } from "zod";

export const ActionAttemptStateEnum = z.enum([
  "PENDING",
  "LEASED",
  "DISPATCHED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN_OUTCOME",
  "BLOCKED"
]);
export type ActionAttemptState = z.infer<typeof ActionAttemptStateEnum>;

export const ActionGrantPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  actor: z.string().min(1),
  runId: z.string().uuid(),
  tool: z.string().min(1),
  paramHash: z.string().min(1),
  target: z.string().min(1),
  resourceVersion: z.number().int().nonnegative(),
  approvalRef: z.string().uuid().optional(),
  exp: z.number().int().positive()
}).strict();
export type ActionGrantPayload = z.infer<typeof ActionGrantPayloadSchema>;

export const ActionProposalInput = z.object({
  tool: z.string().min(1),
  target: z.string().min(1),
  params: z.record(z.string(), z.any()),
  resourceVersion: z.number().int().nonnegative(),
  approvalRef: z.string().uuid().optional()
}).strict();
export type ActionProposalInput = z.infer<typeof ActionProposalInput>;

export const ActionAttemptViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  tool: z.string().min(1),
  target: z.string().min(1),
  paramHash: z.string().min(1),
  resourceVersion: z.number().int().nonnegative(),
  approvalRef: z.string().uuid().nullable().optional(),
  effectKey: z.string().min(1),
  state: ActionAttemptStateEnum,
  leaseOwner: z.string().nullable().optional(),
  fencingToken: z.number().int().nonnegative(),
  providerReceipt: z.any().optional(),
  createdAt: z.string().datetime()
}).strict();
export type ActionAttemptView = z.infer<typeof ActionAttemptViewSchema>;

