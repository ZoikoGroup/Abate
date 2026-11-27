# Zoiko Abate Operational Runbooks (Completion Plan §10.3)

---

## 1. Deploy and Roll Back
1. **Pre-deploy**: Verify CI green (`verify`, `e2e-a11y`), confirm `db:audit -- --require-live` and `generate:openapi -- --check` pass, and record commit SHA + container image digests (`ABATE_IMAGE_DIGESTS`).
2. **Schema migration (expand/contract)**:
   - Run `npm --prefix backend run migrate` using `abate_migrator`.
   - Any `CREATE INDEX CONCURRENTLY` migration MUST include `-- migrate:no-transaction` on line 1 so it runs outside `BEGIN/COMMIT`.
   - New columns/tables are added before switching application code; destructive drops wait for a subsequent release.
3. **Rollback**:
   - Roll back application containers to the previous pinned image digest (`abate-backend:<sha>`, `abate-frontend:<sha>`).
   - Because migrations follow expand-then-contract, the prior release remains compatible with the expanded schema.

## 2. Restore and Reconcile
1. **Trigger**: Database corruption, accidental loss, or disaster recovery rehearsal (`RPO <= 15m`, `RTO <= 4h`).
2. **Steps**:
   - Record **declaration timestamp** (`T_declare`).
   - Restore PostgreSQL base backup + WAL archive to target recovery timestamp into an isolated environment.
   - Reconcile external tombstone logs (`tombstones/<tenantId>/*.json` in object storage) and run `npx tsx backend/tools/reconcile-after-restore.ts` / `measure-pg-restore.ts` to guarantee `0` resurrected records.
   - Reconcile `UNKNOWN_OUTCOME` action attempts against provider receipts before any re-dispatch (`reconcileUnknownOutcomeActions`).
   - Verify `npm --prefix backend run db:audit -- --require-live` and `npm --prefix backend run verify-pg-smoke`.
   - Record **traffic-approved timestamp** (`T_approve`) and last recoverable change timestamp (`T_rpo`).

## 3. Kill Switch Use (Five Scopes)
Use `POST /api/v2/ops/kill-switches` (support token + non-empty `reason` required) or Operations Console:
1. `connector:<source>` (`connector:zoikotime`, `connector:calendar_cadence`): Immediately blocks ingestion (`503`) for that connector; existing reads/hazards stay `200`.
2. `release_path`: Immediately blocks `POST /api/v2/releases/query` (`503`) if privacy engine anomalies occur; manual workflow remains `200`.
3. `pack:<pack_key>` (`pack:legal-uk-sra`): Marks policy pack restricted / `NOT_COVERED` (`503` on sector routes) without affecting generic core.
4. `all_ai` (or `use_case:<key>`, `model:<ref>`, `provider:<name>`): Immediately disables AI endpoints (`503`) while manual hazard/control workflows remain operational.
5. `tool:<name>` (`tool:ticket_notification`): Blocks external action dispatch (`503`) without affecting read/ops endpoints.

## 4. Dead-Letter Handling (Human-Approved Replay)
1. Inspect dead-letter references via `GET /api/v2/ops/jobs` (stores `outbox_id`, `aggregate_id`, `attempts`, `last_error` — zero raw payloads).
2. Confirm downstream consumer health and idempotency before replaying.
3. Re-queue only after human operator review; consumer `inbox_event` deduplication prevents duplicate side effects.

## 5. Key Rotation and Secret Compromise
1. Secrets (`AUTH_SECRET`, `SUPPORT_AUTH_SECRET`, `ACTION_GRANT_SECRET`, `PSEUDONYM_SECRET`, DB credentials, `CONNECTOR_WEBHOOK_SECRET`) live exclusively in the secret manager (`ABATE_SECRETS_FILE` / `ABATE_SECRETS_DIR`), never in git or images.
2. **JWT / Webhook / Grant keys**: Rotate via staged secret manager update + rolling restart (`OIDC_JWKS_URI` supports multi-key rotation without downtime, tested in `test-pilot-readiness.ts`).
3. **`PSEUDONYM_SECRET`**: Do NOT rotate casually — changing it alters HMAC pseudonyms and `recordKeyDigest` tombstones; follow formal key-migration procedure if compromised.

## 6. Privacy Incident Containment
1. Activate `release_path` kill switch immediately (`POST /api/v2/ops/kill-switches`).
2. Query `disclosure_ledger` (as authorized `abate_release_compiler` / incident lead — never `abate_app`) to identify affected `release_id`s and mark compromised releases `WITHDRAWN`.
3. Preserve safe audit references (never log raw values) and route customer/regulatory communication through the named Privacy/Legal Owner.

## 7. Connector Sent a Prohibited Field
1. Verify ingestion rejected the batch fail-closed (`400 VALIDATION` or `rejected` count incremented).
2. Run decoy forensic check: confirm `0` occurrences in `work_fact_revision`, `ingest_receipt`, `dead_letter_event`, telemetry (`GET /api/v2/ops/errors`), and container logs.
3. If a connector keeps sending prohibited payloads, suspend it reversibly (`POST /api/v2/connections/:id/suspend`) or activate `connector:<source>` kill switch until fixed by source owner.

## 8. Support Access (Zero-Impersonation)
- Support operators authenticate with `SUPPORT_AUTH_SECRET` / support OIDC credentials (`aud: abate-support`, no `tenant_id`).
- **Permitted**: `GET /api/v2/ops/slo`, `GET /api/v2/ops/errors`, `GET /api/v2/ops/alerts`, `GET /api/v2/ops/jobs`, `GET /api/v2/ops/ai-quota`, `POST /api/v2/ops/diagnostic-receipts/verify`, `POST /api/v2/ops/kill-switches`.
- **Prohibited**: Support credentials are rejected (`401`/`403`) on all tenant endpoints and `/api/v2/admin/*` endpoints, and `abate_ops` has zero grants on tenant business tables or admin writes (`0094`).

## 9. Platform Admin Lifecycle & Break-Glass
- See [`docs/runbooks/platform-admin-lifecycle.md`](../docs/runbooks/platform-admin-lifecycle.md) and [`docs/architecture/ADR-007-admin-model-stepup-foureyes.md`](../docs/architecture/ADR-007-admin-model-stepup-foureyes.md) (`DRAFT — PENDING SECURITY OWNER APPROVAL`).

## 10. Tenant Suspension, Reactivation & Governed Offboarding
- See [`docs/runbooks/tenant-suspension-and-offboarding.md`](../docs/runbooks/tenant-suspension-and-offboarding.md) (Step-Up + Four-Eyes mandatory; no instant hard delete).
