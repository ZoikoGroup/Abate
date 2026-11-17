# Pilot Readiness Runbook (Stage B Item 6)

This guide describes how to run Zoiko Abate outside `local`/`test` with dev token issuance disabled, external secrets mounted, durable S3 storage enforced, and monitoring/alerts enabled.

## 1. OIDC Login & Disabled Dev Tokens

- Outside `APP_ENV=local` and `APP_ENV=test` (or whenever `ABATE_DISABLE_DEV_TOKEN=1` is set):
  - `POST /api/v2/auth/token`, `POST /api/v2/auth/refresh`, and `POST /api/v2/auth/support-token` return `404`.
  - Symmetric `HS256` dev bearer tokens are rejected with `401`.
  - Protected routes accept either:
    1. Asymmetric OIDC JWTs (`RS256`, `ES256`, `PS256`, etc.) verified via `OIDC_JWKS_URI`, `OIDC_JWKS_JSON`, or `OIDC_PUBLIC_KEY_PEM`.
    2. Server-signed `HttpOnly; SameSite=Lax` `abate_session` cookies issued by `POST /api/v2/auth/oidc/exchange` after PKCE S256 / asymmetric OIDC verification.
- The frontend queries `GET /api/v2/auth/oidc/config` on boot. When `devTokenEnabled` is `false`, auto-minting via `/api/v2/auth/token` is skipped, dev persona pickers and demo launchers are hidden, and an OIDC Sign-In flow is shown.

## 2. External Secret Manager Wiring

Never store plaintext `.env` secrets in deployment images. Configure either:

- **JSON bundle mount**: `ABATE_SECRETS_FILE=/run/secrets/abate-secrets.json` (see `ops/pilot-secrets.example.json` for schema), OR
- **Volume-per-key mount** (Kubernetes CSI / Docker Swarm / GCP Secret Manager volumes): `ABATE_SECRETS_DIR=/run/secrets` where each file name matches the environment variable (`AUTH_SECRET`, `DATABASE_URL_APP`, `OIDC_JWKS_URI`, etc.).

In `staging` and `production`, `validateRuntimeConfig` fails closed at startup unless:
- `AUTH_SECRET`, `SUPPORT_AUTH_SECRET`, `ACTION_GRANT_SECRET`, and `OBJECT_STORE_SECRET_KEY` are distinct, non-default, and `>= 32` characters.
- `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, and `DATABASE_URL_WORKER` use separate PostgreSQL roles and `ABATE_REQUIRE_PG=1`.
- `OBJECT_STORE_MODE=s3` with non-default credentials/endpoint.
- `OIDC_JWKS_URI`, `OIDC_JWKS_JSON`, or `OIDC_PUBLIC_KEY_PEM` is configured.
- In `production`, `CLIENT_URL` uses `https://` and `AUTH_ISSUER` is non-localhost.
- `FIXED_CLOCK` is unset.

## 3. Durable Object Storage

Set `OBJECT_STORE_MODE=s3` (the automatic default in `staging` and `production`) and configure `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_BUCKET`, `OBJECT_STORE_REGION`, `OBJECT_STORE_ACCESS_KEY`, and `OBJECT_STORE_SECRET_KEY`.
`GET /api/health` checks both PostgreSQL (`SELECT 1`) and `S3ObjectStore.health()`, returning HTTP `503` (`status: "degraded"`) if either required dependency is unavailable.

## 4. Monitoring, Prometheus Metrics & Alerts

- **Health probe**: `GET /api/health` (DB mode/reachability, S3 object store reachability, worker queue depth/dead-letters).
- **Prometheus metrics**: `GET /metrics` (protected by `METRICS_AUTH_TOKEN` bearer token or support OIDC/support JWT in hardened environments). Exposes:
  - `abate_http_requests_total{route_class}` & `abate_http_request_duration_ms_p95{route_class}`
  - `abate_http_availability_ratio` & `abate_http_server_errors_total`
  - `abate_privacy_released_total`, `abate_privacy_suppressed_total` (normal k-anonymity suppression), `abate_privacy_engine_errors_total`
  - `abate_worker_queue_depth`, `abate_worker_queue_lag_ms`, `abate_worker_dead_letters_total`
  - `abate_dependencies_up{component="database|object_store"}`
- **Live alert evaluation**: `GET /api/v2/ops/alerts` (requires support token; returns `OK` or `FIRING` against SLA thresholds).
- **Prometheus alert rules**: Deploy `ops/alerts.prometheus.yml`.
- **Structured JSON request logs**: Automatically enabled in `staging`/`production` (or via `ABATE_STRUCTURED_LOGS=1`), logging only `level`, `at`, `requestId`, `method`, `routeClass`, `status`, and `durationMs` (zero tenant IDs, bodies, cookies, or PII).
