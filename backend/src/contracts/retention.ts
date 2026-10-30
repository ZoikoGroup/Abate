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
 * Jurisdiction pack content. Authored by the Legal & Policy Lead, never by development.
 * Floors/ceilings bound what a tenant may configure; absence of a bound means "not constrained by this pack".
 */
export const JurisdictionPackContent = z.object({
  title: z.string().min(3),
  sourceRefs: z.array(z.string().min(3)).min(1),
  retention: z.record(DataCategoryEnum, z.object({
    floor: DurationBound.optional(),
    ceiling: DurationBound.optional()
  }).strict()).default({} as any),
  notes: z.string().optional()
}).strict();
export type JurisdictionPackContent = z.infer<typeof JurisdictionPackContent>;

export const PublishPackInput = z.object({
  packId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  version: z.number().int().positive(),
  jurisdiction: z.string().min(2),
  sector: z.string().min(2),
  effectiveFrom: z.string().datetime(),
  content: JurisdictionPackContent,
  approvedBy: z.string().min(3)
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
  packId: string;
  version: number;
  jurisdiction: string;
  sector: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "APPROVED" | "RETIRED";
  content: JurisdictionPackContent;
  contentHash: string;
  approvedBy: string;
}

export type JurisdictionCoverage =
  | { status: "COVERED"; pack: JurisdictionPackView }
  | { status: "NOT_COVERED"; packId: string | null; at: string };

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
