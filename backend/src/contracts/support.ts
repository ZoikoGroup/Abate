// backend/src/contracts/support.ts
import { z } from "zod";

// B8: support operator token request (dev issuance only). No tenant field by design.
export const SupportTokenRequestBody = z.object({
  operator: z.string().regex(/^[a-z0-9._@-]{3,64}$/i)
}).strict();
export type SupportTokenRequestBody = z.infer<typeof SupportTokenRequestBody>;
