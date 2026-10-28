// backend/src/contracts/tenant.ts
import { z } from "zod";

export const CreateOrganizationBody = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().optional()
}).strict(); // Playbook requires strict schema: reject unknown fields

export type CreateOrganizationBodyType = z.infer<typeof CreateOrganizationBody>;

export const TokenRequestBody = z.object({
  tenantId: z.string().uuid(),
  subject: z.string().min(1),
  role: z.enum(["RISK_OWNER", "CONTROL_OWNER", "REVIEWER", "EMPLOYER_ADMIN"]).default("RISK_OWNER"),
  purpose: z.string().default("WORKPLACE_RISK_ASSESSMENT")
}).strict();

export type TokenRequestBodyType = z.infer<typeof TokenRequestBody>;

