# Customer-Side Pilot Facts Pack (`G-32` / Completion Plan §9 & §11)

> **Owner**: Product & Legal (customer-facing delivery); **Engineering supplies verified technical facts below.**
> **Status**: Technical facts baseline ready for Product/Legal packaging per customer pilot. No compliance certification is claimed.

---

## 1. Processing Scope & Minimization Facts
- **Purpose**: Organizational work-design and psychosocial-risk assessment at **cohort level only** (`n >= 10` distinct eligible contributors for Class B/C releases).
- **Data Ingested (Strict Allow-List)**:
  - Source work cadence intervals (`startUtc`, `endUtc`, IANA `workTz`, `kind`), contract/connection metadata, and tenant-scoped HMAC-SHA256 subject pseudonyms (`PSEUDONYM_SECRET` isolated from JWT signing secrets).
- **Data Strictly Rejected at the Boundary (Never Persisted, Never Logged, Never Dead-Lettered)**:
  - Screenshots, keystrokes, URLs, application names, email/message contents, meeting titles/attendees/descriptions, substantive legal work product, billing rates, medical/sickness reasons, individual scores, or worker rankings.
  - Enforced via strict Zod `.strict()` contracts (`400 VALIDATION` returning field name only, never echoing submitted values) and verified by automated decoy labs (`test-phase2-ingestion.ts`, `run-incident-exercise.ts`).

---

## 2. Privacy Release & Anti-Reconstruction Controls (For DPIA)
- **Single Read Path ("Channel Parity")**: Dashboard, CSV export, API, support receipts, and Bounded AI all read exclusively from `released_artifact` (which omits `contributor_count` by schema).
- **Deterministic Disclosure Controls**:
  - Minimum cohort floor: `n >= 10` distinct eligible contributors.
  - Minimum observation window (Class B): `28` days.
  - Overlap protection: symmetric difference `< 5` between overlapping cohorts blocks release.
  - Parent/child residual protection: residual `< 5` blocks release.
  - Concurrency: tenant-wide `pg_advisory_xact_lock` serializes competing release requests so two concurrent users cannot race past disclosure history.
  - Uniform suppression: `UNAVAILABLE` returns an identical calm message without revealing hidden counts, thresholds, or exact suppression reasons.
- **Note on Terminology**: Until the Privacy Owner signs a formal noise decision in `docs/governance/open-signoffs.md`, Abate uses **deterministic disclosure suppression**, NOT formal differential privacy (enforced by CI `lint:wording`).

---

## 3. Worker Consultation, Notices & Two-Plane Boundary Facts
- **No Automated Individual Employment Decisions**: Abate produces zero individual scores, zero worker rankings, and zero automated HR/disciplinary triggers.
- **Two Value Planes**:
  - **Plane A (Risk Assurance)**: Hazard → Cause → Control → Version-Bound Approval → Implementation Receipt → Verification → Disposition → Evidence Package.
  - **Plane B (Work-Design Outcomes)**: Feature-flagged (`outcomes_plane_b`, default OFF), separate write role (`abate_performance`), and database trigger (`assert_plane_a()`) preventing Plane B metrics from modifying or closing Plane A safety obligations.
- **Bounded AI (Optional & Proposal-Only)**: Every workflow completes with AI disabled (`all_ai` kill switch). AI retrieves released evidence only, validates schema/citations/numbers/prohibited inferences, and never trains general models on customer data.

---

## 4. Data Subject Rights (GDPR Art 17 Erasure) & Retention Facts
- **No Invented Universal Defaults**: Retention runs delete nothing until the tenant configures an approved retention class bounded by its active effective-dated jurisdiction pack.
- **Legal Hold Precedence**: Active legal holds (`legal_hold`) override both scheduled retention and Art 17 erasure; held facts are retained and reported explicitly as `heldExceptions`.
- **Verified Hard Deletion & Anti-Resurrection**:
  - Unheld facts are hard-deleted only after writing a content-free cryptographic digest tombstone (`deletion_tombstone`, zero pseudonyms or source IDs) and re-reading to verify absence.
  - Overlapping derived `metric_snapshot` / `privacy_release` rows are marked `STALE`.
  - External tombstone logs (`tombstones/<tenantId>/<runId>.json` in versioned S3 object storage) are replayed during disaster recovery (`reconcile-after-restore.ts`, `measure-pg-restore.ts`) so erased data never resurrects after backup restore.

---

## 5. Technical Security & Zero-Impersonation Support Facts
- **Tenant Isolation**: PostgreSQL `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant table; transaction-local `app.tenant_id`; 8 least-privilege DB roles with separate connection pools (`docs/db-audit.sql` enforced in CI).
- **Authentication**: OIDC PKCE with RS256/ES256 JWKS verification and `HttpOnly; SameSite=Lax; Secure` session cookies; dev token endpoints return `404` outside `local`/`test`.
- **Support Access**: Separate credentials (`abate_ops` / `SUPPORT_AUTH_SECRET`); support cannot impersonate tenant users or read tenant business tables; tenants share signed, content-free diagnostic receipts (`POST /api/v2/support/diagnostic-receipts`).
