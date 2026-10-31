// backend/src/contracts/governance.ts
import { z } from "zod";

export const PolicyPackKindEnum = z.enum(["JURISDICTION", "SECTOR", "CUSTOMER"]);
export type PolicyPackKind = z.infer<typeof PolicyPackKindEnum>;

export const PolicyPackStatusEnum = z.enum(["DRAFT", "APPROVED", "WITHDRAWN"]);
export type PolicyPackStatus = z.infer<typeof PolicyPackStatusEnum>;

export const PackRefSchema = z.object({
  key: z.string(),
  version: z.number().int().min(1),
  hash: z.string()
}).strict();
export type PackRef = z.infer<typeof PackRefSchema>;

export const PolicyResolutionSchema = z.object({
  applied: z.array(PackRefSchema),
  restricted: z.array(z.string()),
  conflicts: z.array(z.string()),
  requiredGates: z.array(z.enum(["APPROVAL", "CONSULTATION", "REVIEW"])),
  ambiguous: z.boolean()
}).strict();
export type PolicyResolution = z.infer<typeof PolicyResolutionSchema>;

export const CommercialDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(["NOT_ENTITLED", "POLICY_RESTRICTED"]).optional()
}).strict();
export type CommercialDecision = z.infer<typeof CommercialDecisionSchema>;

export const EntitlementsSchema = z.object({
  tier: z.enum(["COMMUNITY", "STANDARD", "ENTERPRISE"]),
  features: z.array(z.string()),
  suspendedFeatures: z.array(z.string())
}).strict();
export type Entitlements = z.infer<typeof EntitlementsSchema>;

export const DecisionEnvelopeViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  decisionType: z.string(),
  resourceId: z.string().uuid(),
  resolvedAt: z.string().datetime(),
  resolution: PolicyResolutionSchema,
  metricVersions: z.record(z.string(), z.number()).optional(),
  privacyProfile: z.string().optional(),
  sectorPack: z.string().optional(),
  modelPromptVersions: z.record(z.string(), z.string()).optional()
}).strict();
export type DecisionEnvelopeView = z.infer<typeof DecisionEnvelopeViewSchema>;

export const EvidencePackageStateEnum = z.enum(["ISSUED", "SUPERSEDED", "WITHDRAWN"]);
export type EvidencePackageState = z.infer<typeof EvidencePackageStateEnum>;

export const EvidencePackageViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  scope: z.record(z.string(), z.any()),
  cutoff: z.string().datetime(),
  issuerPrincipalId: z.string().uuid(),
  classification: z.enum(["RESTRICTED", "CONFIDENTIAL", "PUBLIC"]),
  manifestHash: z.string(),
  supersedesId: z.string().uuid().nullable().optional(),
  supersededById: z.string().uuid().nullable().optional(),
  state: EvidencePackageStateEnum,
  issuedAt: z.string().datetime(),
  itemsCount: z.number().int().min(0),
  items: z.array(z.object({
    itemType: z.string(),
    itemId: z.string().uuid(),
    itemVersion: z.number().int().min(1),
    sha256: z.string(),
    objectKey: z.string()
  })).optional()
}).strict();
export type EvidencePackageView = z.infer<typeof EvidencePackageViewSchema>;

export const RightsRequestInputSchema = z.object({
  subjectPseudonym: z.string().min(1)
}).strict();
export type RightsRequestInput = z.infer<typeof RightsRequestInputSchema>;

export const RightsRequestViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  subjectPseudonym: z.string(),
  status: z.enum(["RECEIVED", "PROCESSING", "COMPLETED", "REJECTED"]),
  deletedCount: z.number().int().min(0),
  heldExceptions: z.number().int().min(0),
  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional()
}).strict();
export type RightsRequestView = z.infer<typeof RightsRequestViewSchema>;

export const AcknowledgeCorrectionInputSchema = z.object({
  reviewerNotes: z.string().min(1)
}).strict();
export type AcknowledgeCorrectionInput = z.infer<typeof AcknowledgeCorrectionInputSchema>;

// Late correction of a ledger record (Playbook B5 §3 Step 8). The revision must already be in the ledger.
export const CorrectionInputSchema = z.object({
  connectionId: z.string().uuid(),
  sourceRecordId: z.string().min(1),
  revision: z.number().int().min(2)
}).strict();
export type CorrectionInput = z.infer<typeof CorrectionInputSchema>;
