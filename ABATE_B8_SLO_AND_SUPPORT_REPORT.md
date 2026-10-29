# Abate — B8: SLO Workload Targets & Zero-Impersonation Support

**Playbook package:** B8 (built from `adr/decisions-register.md`; no B8 spec PDF was available)
**Code:** `backend/src/platform/{telemetry,slo,canonical}.ts`, `backend/src/domains/support/`
**Date:** 29 October 2026
**Status:** Implemented and verified. Still needs to be checked against the official B8 spec (see §6).

---

## 1. What the register required

| Register row | Requirement | Delivered |
|---|---|---|
| SLO Workload Targets | Reads p95 ≤ 500 ms, writes ≤ 800 ms, released analytics ≤ 1.5 s, 99.9% monthly availability | Per-request telemetry, a class per route, an SLO report with error budget, and an HTTP load gate (`test-slo`) |
| Production Support Coverage | Zero-impersonation support model; safe error logs only; no ad-hoc DB access; diagnostic receipts without raw data | Separate support credential that cannot reach tenant routes; fingerprint-only error logs; signed tenant-issued diagnostic receipts; request lookup by `requestId` |

## 2. Design

**Telemetry and SLOs.** `telemetryMiddleware` gives every request an id (`X-Request-Id`, also returned in every error body) and records method, **route template** (e.g. `/api/v2/organizations/:id`, never the raw URL), status and duration. It records no tenant id, subject, body or error message.
- Route classes: `/api/v2/releases*` is RELEASED_ANALYTICS; other GETs are READ; other methods are WRITE. Health, metadata, token issuance and the ops plane are excluded.
- `buildSloReport` computes nearest-rank p95 per class against the register targets. Availability counts **only 5xx** as failures, because 4xx are correct refusals. It also reports the error budget and the five slowest route templates.

**Safe error logs.** The previous fallback in `toErrorResponse` called `console.error(error)`, writing driver messages (which can include row values) to the log. Now:
- Unexpected errors are logged as `{requestId, errorName, fingerprint}`, where the fingerprint is a SHA-256 prefix of name and message, so recurrences can be grouped without exposing content.
- A final Express error handler means malformed JSON gets the JSON `VALIDATION` envelope instead of Express's HTML stack page.

**Zero impersonation.** Support operators hold a token for a separate audience (`abate-api:support`) with scope `platform-support` and **no tenant claim**. A support-audience token that names a tenant is refused.
- Tenant routes verify the tenant audience, so support tokens are rejected there (401). Tenant tokens are rejected on `/api/v2/ops/*`.

**No ad-hoc DB access: diagnostic receipts.** The tenant issues `POST /api/v2/support/diagnostic-receipts` (idempotent, audited, emits an outbox event).
- The receipt holds states and counts only: connection health, ingest receipt counts, outbox backlog, releases by status, retention coverage/class/holds/last run. It lists what was excluded and is HMAC-signed.
- Support checks it with `POST /api/v2/ops/diagnostic-receipts/verify`; any edit, or a forged receipt, fails.
- Support never queries tenant data. It sees only signed receipts and request records.

## 3. API

| Method | Path | Credential |
|---|---|---|
| POST | `/api/v2/auth/support-token` | none; **local/test only** (404 elsewhere) |
| GET | `/api/v2/ops/slo` | support |
| GET | `/api/v2/ops/requests/:requestId` | support |
| GET | `/api/v2/ops/errors` | support |
| POST | `/api/v2/ops/diagnostic-receipts/verify` | support |
| POST | `/api/v2/support/diagnostic-receipts` | tenant (`Idempotency-Key`) |

## 4. Verification

- `npm --prefix backend run test-fast`: 9/9 (4 new: p95/route classes, breach detection and 5xx-only availability, safe logs, token separation).
- `npm --prefix backend run test-boundaries`: 34/34 (2 new: receipts are content-free and tenant-scoped; tampering and forgery fail).
- `npm --prefix backend run test-slo` (**new**): runs the real app on an ephemeral port with 360 requests (120 per class), then checks the SLO report (all MET, 0 server errors), zero impersonation over HTTP, requestId correlation with no raw ids in ops records, the malformed-JSON envelope, and signed receipts. Local run: p95 READ 14 ms, WRITE 16 ms, ANALYTICS 20 ms.
- Mutation-checked: logging the raw error again, removing the final error handler, or accepting tenant-bound support tokens each makes a test fail.
- `demo-cycle`: new Step 14 (issue receipt, verify, reject an edited copy).
- Browser check of the new "Operations & Support (B8)" tab.

Also changed: `src/index.ts` only listens when it is the entrypoint (`require.main === module`), so tools can mount the app. Canonical JSON moved to `platform/canonical.ts` (lifecycle re-exports it).

## 5. Limits (stated, not hidden)

- **The SLO window is in-process** (last 5,000 requests since this instance started). Monthly 99.9% availability and multi-instance p95 need external monitoring/metrics export; the report says so in its `scope` field.
- `test-slo` numbers come from the in-memory engine on one machine. They show the gate works, not production performance.
- Support tokens share the dev signing secret with tenant tokens. In production they should come from the identity provider under a separate key.
- Telemetry and the safe error log are in memory and reset on restart.

## 6. Assumptions to check against the B8 spec

1. Route classes: everything under `/api/v2/releases` is "released analytics"; every other non-GET is a write.
2. 4xx responses do not consume availability budget.
3. What a diagnostic receipt includes (listed in §2), and that support may see the tenant id and connection ids (opaque UUIDs).
4. Requests carry no tenant attribution in ops telemetry; support correlates through the `requestId` the tenant reports.
