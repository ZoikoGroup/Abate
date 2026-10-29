// backend/src/contracts/release.ts
import { z } from "zod";

export const ReleaseClassEnum = z.enum(["CLASS_A", "CLASS_B", "CLASS_C"]);
export type ReleaseClass = z.infer<typeof ReleaseClassEnum>;

export const SemanticQueryV1 = z.object({
  metricId: z.string().min(1),
  metricVersion: z.number().int().min(1).default(1),
  cohortRef: z.string().min(1),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  releaseClass: ReleaseClassEnum.default("CLASS_B")
}).strict();

export type SemanticQuery = z.infer<typeof SemanticQueryV1>;

export type ReleaseView =
  | {
      status: "RELEASED";
      releaseId: string;
      metricId: string;
      metricName: string;
      version: number;
      value: number | null;
      unit: string;
      cohortRef: string;
      periodStart: string;
      periodEnd: string;
      quality: "VALID" | "DEGRADED" | "NOT_APPLICABLE" | "PARTIAL";
      releasedAt: string;
      freshness: "FRESH" | "SUPERSEDED" | "REVOKED";
      interpretation?: string;
      limits?: string;
      assuranceLabel: string;
    }
  | {
      status: "STALE";
      releaseId: string;
      reason: string;
      supersededAt?: string;
      asOf?: string;
    }
  | {
      status: "UNAVAILABLE";
      code: "NOT_AVAILABLE";
      message?: string;
    };

