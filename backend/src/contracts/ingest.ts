// backend/src/contracts/ingest.ts
import { z } from "zod";

export const SourceAdapterNameEnum = z.enum(["ZoikoTime", "CalendarCadence"]);
export type SourceAdapterName = z.infer<typeof SourceAdapterNameEnum>;

export const CreateConnectionInput = z.object({
  source: SourceAdapterNameEnum,
  contractId: z.string().uuid(),
  expectedCadenceSeconds: z.number().int().min(60).max(86400).default(3600)
}).strict();

export type CreateConnectionInput = z.infer<typeof CreateConnectionInput>;
