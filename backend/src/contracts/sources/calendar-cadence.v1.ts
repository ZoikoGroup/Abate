// backend/src/contracts/sources/calendar-cadence.v1.ts
import { z } from "zod";
import { isIanaZone } from "./zoikotime.v1";

/**
 * CalendarCadence v1 Contract (Domain S02)
 * Allows strictly bounded temporal work-cadence intervals ONLY.
 * Invitee emails, meeting subjects/titles, descriptions, locations, and recordings are prohibited via .strict().
 */
export const CalendarCadenceEventV1 = z.object({
  recordId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  subjectRef: z.string().min(1).max(256),
  startUtc: z.string().datetime(),
  endUtc: z.string().datetime(),
  workTz: z.string().refine(isIanaZone, { message: "Unknown or invalid IANA time zone" }),
  kind: z.enum(["MEETING_BLOCK", "FOCUS_BLOCK", "AFTER_HOURS_CALL"])
}).strict();

export type CalendarCadenceEvent = z.infer<typeof CalendarCadenceEventV1>;

export const CalendarCadenceBatchV1 = z.object({
  connectionId: z.string().uuid(),
  batchId: z.string().min(1).max(256),
  items: z.array(CalendarCadenceEventV1).min(1).max(1000)
}).strict();

export type CalendarCadenceBatch = z.infer<typeof CalendarCadenceBatchV1>;
