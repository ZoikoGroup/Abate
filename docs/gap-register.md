# Consolidated Gap Register (`G-01` – `G-34`)

Source: `Abate_Completion_Plan_DB_Backend_Frontend.pdf` (Section 3, Pages 5–6).
Severity classes: **P0** constitutional (never waived), **P1** blocks general availability, **P2/P3** bounded with owner and expiry. **Pilot blocker** means it must be closed before real customer data touches the system.

| ID | Gap | Sev. | Gate | Acceptance |
|---|---|---|---|---|
| **G-01** | Isolation/boundary suites may run on memDb; memDb and PostgreSQL behaved differently (JSON, FK order, casts) | P1 | G1 | All RLS, role, pool, boundary, worker suites run on live PG in required CI; parity tests for each known memDb/PG difference |
| **G-02** | Hand-written Playwright/Node type stub in `tests/` | P3 | G1 | Real pinned `devDependencies` and lockfile; stub deleted; `tsc` passes |
| **G-03** | Privacy method undecided: deterministic suppression only, or calibrated noise | P0 claim | G3 | Written decision; docs and UI never say differential privacy unless approved, specified and implemented |
| **G-04** | `BE-001` to `010` mapping and `ADR-001` to `005` written by the agent without confirmed access to BE documents | P1 | G9 | Human with the BE documents reviews; state names, roles, thresholds, routes mapped; conflicts logged |
| **G-05** | Legal terms leaked into core; no per-tenant sector setting | P1 | G5 | Generic tenant sees no legal terms; pack controls vocabulary, windows, gates, claims |
| **G-06** | No product decision on sector scope ("all professionals") | P1 | G5 | ADR: Legal first with others as coming, or a scoped multi-sector launch |
| **G-07** | Legal wording and retention durations unapproved | P0 claim | G9 | Legal reviewer signs wording; owners approve durations replacing defaults |
| **G-08** | Dev token endpoint is the login | Pilot blocker | G6 | OIDC with JWKS validation; dev endpoint refuses outside local/test |
| **G-09** | Pseudonym HMAC keys, signing keys, DB credentials not in a secret manager | Pilot blocker | G6 | Keys in KMS/secret manager; rotation tested; none in repo or images |
| **G-10** | No measured RTO and RPO; no point-in-time recovery | P1 | G7 | WAL archiving and base backups; timed restore; recorded RTO and RPO; smoke tests on restored copy |
| **G-11** | SLO values are CI-indicative or in-memory | P2 | G7 | Measured on a fixed environment at the manifest workload; manifest signed |
| **G-12** | No independent challenge yet | P1 | G8 | Report filed; findings closed |
| **G-13** | Endpoint paths differ from the catalog (for example `/ingestion/batches`) | P3 | G4 | `openapi.json` is the source of truth; catalog and docs regenerated from it |
| **G-14** | Not every button and tab verified | P2 | G4 | `docs/button-and-endpoint-checklist.md` all PASS, with evidence |
| **G-15** | Connector state shows `REVOKED`; team wants Suspended | P3 | G4 | Reversible Suspend/Resume plus separate permanent Disconnect; UI label mapping; contract updated |
| **G-16** | AI per-tenant limit needs atomicity and replay tests | P2 | G4 | Concurrent requests cannot exceed quota; replay uses no extra slot; kill switch overrides; ops shows usage |
| **G-17** | Telemetry may carry values | P1 | G6 | Allow-list scrubbing; decoy test passes on logs, traces and error tracker |
| **G-18** | Per-tenant and per-actor rate limits | P2 | G6 | 429 with `Retry-After`; noisy-tenant test passes |
| **G-19** | Connector webhook authenticity and replay protection | P1 | G6 | Signature verification, timestamp window, replay cache; tests |
| **G-20** | Durable object storage for evidence and exports | Pilot blocker | G7 | S3-compatible store with versioning and encryption; hashes reconciled after restore |
| **G-21** | Retention executor, deletion propagation and derived-copy purge | P1 | G2 | Hard delete plus tombstone; caches, indexes and generated copies purged; resurrection test passes |
| **G-22** | Restore reconciliation (tombstones, packs, outbox, `UNKNOWN_OUTCOME`) | P1 | G7 | Restore rehearsal with reconcile script and smoke tests |
| **G-23** | DB audit scripts not in CI | P2 | G2 | RLS/role/grant scan fails the build on violation |
| **G-24** | Migration runner cannot run `CREATE INDEX CONCURRENTLY`; no schema-drift check | P2 | G2 | No-transaction migration flag; drift check job |
| **G-25** | Indexes and query plans unverified at scale | P2 | G7 | `EXPLAIN` tests on hot paths at pilot-size data |
| **G-26** | Accessibility, responsive layouts and all nine states per screen | P2 | G4 | Axe clean; keyboard run-through; states reviewed per screen |
| **G-27** | Dossier sign-off must bind to commit SHA and image digests | P1 | G10 | Stale approval invalidated on code or image change; human enters decision |
| **G-28** | Image and dependency hardening, SBOM, scans | P2 | G6 | Pinned digests, non-root, scans in CI, SBOM in dossier |
| **G-29** | Jurisdiction pack content not reviewed | P1 | G9 | Accountable reviewer and review date recorded for each pack |
| **G-30** | Model provider terms and region; AI evaluation sets | P1 | G9 | Approved provider and region; per-use-case thresholds met |
| **G-31** | Support without impersonation not independently tested | P1 | G8 | Support role cannot read tenant data; receipts only |
| **G-32** | Customer-side items: scope, consultation or notices, DPIA support, training | Pilot blocker | G9 | Product and Legal deliver; engineering supplies facts |
| **G-33** | Overclaim wording may return (SRA compliance, GO, differential privacy, production) | P0 claim | G5 | Wording lint in CI; sweep finds none |
| **G-34** | "S13" naming and sector extension placement | P3 | G5 | Recorded as a sector extension, not a new core domain |
