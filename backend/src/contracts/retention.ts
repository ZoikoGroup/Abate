// backend/src/contracts/retention.ts
import { z } from "zod";

// ==========================================
// Phase 5 (B5): Jurisdiction Packs & Retention
// ==========================================

// Only categories the purge job can physically delete are listed. Adding one needs a spec.
export const DataCategoryEnum = z.enum(["WORK_FACT"]);
export type DataCategory = z.infer<typeof DataCategoryEnum>;

const DurationBound = z.object({
  days: z.number().int().positive(),
  citation: z.string().min(3)
}).strict();

/**
 * Retention section of a JURISDICTION policy pack's content (policy_pack.content.retention).
 * Authored by the Legal & Policy Lead, never by development. A category the pack does not list is
 * "not addressed" and cannot be configured (fail closed); an empty object means addressed, unconstrained.
 */
export const RetentionBounds = z.record(DataCategoryEnum, z.object({
  floor: DurationBound.optional(),
  ceiling: DurationBound.optional()
}).strict());
export type RetentionBounds = z.infer<typeof RetentionBounds>;

// Platform-side publication into the single policy_pack catalog (0051_governance_evidence.sql)
export const PublishPackInput = z.object({
  packKey: z.string().regex(/^[a-z0-9-]{3,64}$/),
  version: z.number().int().positive(),
  kind: z.enum(["JURISDICTION", "SECTOR", "CUSTOMER"]),
  effectiveFrom: z.string().datetime(),
  sourceRefs: z.array(z.string().min(3)).min(1),
  accountableReviewer: z.string().min(3),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.object({
    title: z.string().min(3),
    retention: RetentionBounds.optional()
  }).passthrough()
}).strict();
export type PublishPackInput = z.infer<typeof PublishPackInput>;

export const SetRetentionClassInput = z.object({
  dataCategory: DataCategoryEnum,
  retentionDays: z.number().int().positive(),
  basis: z.string().min(5)
}).strict();
export type SetRetentionClassInput = z.infer<typeof SetRetentionClassInput>;

export const PlaceLegalHoldInput = z.object({
  dataCategory: DataCategoryEnum,
  scopeConnectionId: z.string().uuid().optional(),
  matterRef: z.string().min(2),
  reason: z.string().min(5)
}).strict();
export type PlaceLegalHoldInput = z.infer<typeof PlaceLegalHoldInput>;

export const ReleaseLegalHoldInput = z.object({
  releaseReason: z.string().min(5)
}).strict();
export type ReleaseLegalHoldInput = z.infer<typeof ReleaseLegalHoldInput>;

export const RunRetentionInput = z.object({
  dataCategory: DataCategoryEnum
}).strict();
export type RunRetentionInput = z.infer<typeof RunRetentionInput>;

// ==========================================
// Server-Computed Views
// ==========================================

export interface JurisdictionPackView {
  packKey: string;
  version: number;
  kind: "JURISDICTION" | "SECTOR" | "CUSTOMER";
  title: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "DRAFT" | "APPROVED" | "WITHDRAWN";
  retention: RetentionBounds | null;
  sourceRefs: string[];
  accountableReviewer: string;
  contentHash: string;
}

export type JurisdictionCoverage =
  | { status: "COVERED"; pack: JurisdictionPackView }
  | { status: "NOT_COVERED"; reason: string; boundPackKeys: string[]; at: string };

export interface RetentionRunReceipt {
  runId: string;
  dataCategory: DataCategory;
  status: "COMPLETED" | "NO_POLICY" | "BLOCKED";
  blockedReason?: string;
  retentionClassId: string | null;
  retentionClassVersion: number | null;
  cutoff: string | null;
  eligible: number;
  held: number;
  purged: number;
  verified: number;
  completedAt: string;
}
