// backend/src/contracts/sources/zoikotime.v1.ts
import { z } from "zod";

export function isIanaZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ZoikoTimeIntervalV1 = z.object({
  recordId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  subjectRef: z.string().min(1).max(256), // source person key (will be pseudonymized)
  startUtc: z.string().datetime(), // must be valid ISO UTC string
  endUtc: z.string().datetime(),
  workTz: z.string().refine(isIanaZone, { message: "Unknown or invalid IANA time zone" }),
  kind: z.enum(["WORK", "BREAK_UNPAID"]) // approved vocabulary only
}).strict(); // .strict() turns ANY extra/prohibited field into a validation error

export type ZoikoTimeInterval = z.infer<typeof ZoikoTimeIntervalV1>;

export const ZoikoTimeBatchV1 = z.object({
  connectionId: z.string().uuid(),
  batchId: z.string().min(1).max(256),
  items: z.array(ZoikoTimeIntervalV1).min(1).max(1000)
}).strict();

export type ZoikoTimeBatch = z.infer<typeof ZoikoTimeBatchV1>;

