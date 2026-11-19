#!/usr/bin/env bash
# infra/run-staging-evidence.sh
# One-command fixed-environment evidence runner for Completion Plan Wave 7 / Phase C (G7).
#
# Usage:
#   ABATE_MEASURED_ENV="staging-eu-west-2-c6i.xlarge" \
#   DATABASE_URL_MIGRATOR="postgres://abate_migrator:...@localhost:5432/abate" \
#   DATABASE_URL_APP="postgres://abate_app:...@localhost:5432/abate" \
#   DATABASE_URL_WORKER="postgres://abate_worker:...@localhost:5432/abate" \
#   ./infra/run-staging-evidence.sh

set -euo pipefail

if [[ -z "${ABATE_MEASURED_ENV:-}" ]]; then
  echo "ERROR: Set ABATE_MEASURED_ENV=<fixed-staging-host-label> before running measured evidence." >&2
  exit 1
fi

export ABATE_REQUIRE_PG="1"

echo "=== Zoiko Abate Fixed-Environment Staging Evidence Run (${ABATE_MEASURED_ENV}) ==="

echo "[1/9] Running clean/forward SQL migrations..."
npm --prefix backend run migrate

echo "[2/9] Running PostgreSQL catalog audit (docs/db-audit.sql)..."
npm --prefix backend run db:audit -- --require-live

echo "[3/9] Running live PostgreSQL role, trigger & parity suite..."
npm --prefix backend run test-pg-parity -- --require-live

echo "[4/9] Running hot-path EXPLAIN index verification..."
npm --prefix backend run test-explain -- --require-live

echo "[5/9] Running manifest-scale HTTP/TCP load benchmark (20 tenants, 1,500 principals, 400k facts, 150 concurrency)..."
npm --prefix backend run test-load:manifest

echo "[6/9] Running timed PostgreSQL backup/restore + anti-resurrection RTO/RPO drill..."
npm --prefix backend run measure-restore

echo "[7/9] Verifying WAL archiving & PITR readiness..."
npm --prefix backend run rehearse:pitr -- --require-live

echo "[8/9] Running key-rotation rehearsal & live incident exercise..."
npm --prefix backend run rehearse:key-rotation
npm --prefix backend run drill:incident

echo "[9/9] Generating SBOM & assembling Release Evidence Dossier (READY FOR REVIEW)..."
npm --prefix backend run generate:sbom
npm --prefix backend run build-dossier
npm --prefix backend run check:gates

echo "=== Completed Staging Evidence Run. Update ops/slo-manifest.v1.yaml with measured numbers and present to Release Authority. ==="
