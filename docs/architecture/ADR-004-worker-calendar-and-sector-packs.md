# ADR-004: Worker Daemon, CalendarCadence Isolation & Legal Sector Pack

- **Status**: **DRAFT — Pending Human Review** (agent-authored from codebase inspection; awaiting BE spec holder & Legal Reviewer acceptance)
- **Date**: 2026-11-16
- **Scope**: Worker Daemon (`backend/src/worker/daemon.ts`), Connectors (`CalendarCadence`), Legal Pack (`backend/src/domains/sector-legal/`)

## Context
Later platform phases added: (1) a resilient outbox worker daemon (`0080_worker_daemon.sql`), (2) a `CalendarCadence` connector ingesting temporal meeting/focus/after-hours metadata (`MEETING_BLOCK`, `FOCUS_BLOCK`, `AFTER_HOURS_CALL`), and (3) Domain S13 UK Legal Sector Pack rules (`sector-legal` / `legal-uk-sra`).

## Decision
1. **Calendar Metadata Minimization & Non-Double-Counting**:
   - `CalendarCadenceEventV1` permits only `{ recordId, revision, subjectRef, startUtc, endUtc, workTz, kind }` with `.strict()`, rejecting titles, attendees, locations, URLs, and descriptions.
   - `compileRelease` (`backend/src/domains/privacy/compile-release.ts`) filters `WHERE tenant_id = $1 AND kind = 'WORK' AND start_at >= $2 AND end_at <= $3` (mirrored identically in `MemoryClient`), guaranteeing calendar cadence blocks do not double-count or distort `WORK` hours.
2. **Dead-Letter Reference Minimization**: `worker/daemon.ts` and `0080_worker_daemon.sql` record reference IDs only in `dead_letter_event`, never raw event payloads, and support crash-safe inbox deduplication.
3. **UK Legal Sector Framing**: Domain S13 features (`fatigue-check`, `matter-map`) are framed strictly as **SRA-aligned organizational controls** supporting legal practice supervision rather than automated legal compliance certification (`"SRA 2023 Compliance"` wording removed).

## Open Decision Required (Stage B Gate)
Named **Legal & Policy Reviewer** must approve real statutory citations, sector demand-window wording, and jurisdiction retention bounds before any non-synthetic customer onboarding.
