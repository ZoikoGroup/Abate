// backend/src/contracts/common.ts
import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION",
  "UNAVAILABLE"
]);

export const ErrorBody = z.object({
  code: ErrorCodeSchema,
  message: z.string(), // safe human readable; never leaks hidden facts
  requestId: z.string()
});

export type ErrorBodyType = z.infer<typeof ErrorBody>;

export const EventEnvelope = z.object({
  eventId: z.string().uuid(),
  tenantId: z.string().uuid(),
  aggregate: z.string(),
  aggregateVersion: z.number().int(),
  eventTime: z.string(),
  schemaVersion: z.string(),
  purpose: z.string(),
  refs: z.array(z.string()) // safe references, never private payloads
});

export type EventEnvelopeType = z.infer<typeof EventEnvelope>;

