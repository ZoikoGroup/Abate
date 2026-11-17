# ADR-005: Cryptographic Dossier Binding & Container Hardening

- **Status**: **DRAFT — Pending Human Review** (agent-authored from codebase inspection; awaiting BE spec holder acceptance)
- **Date**: 2026-11-16
- **Scope**: Release Evidence (`backend/tools/build-dossier.ts`, `sign-dossier.ts`) & Containers (`Dockerfile`, `.dockerignore`, `docker-compose.yml`)

## Context
During pre-Stage A hardening, an agent-generated `evidence/dossier-signoff.json` existed and `build-dossier.ts` carried forward prior sign-offs on subsequent runs unless test gates failed — creating a risk that stale approvals could authorize modified code or container images. Furthermore, Docker base tags floated (`node:22-alpine`) and frontend Nginx ran as `root` on port `80`.

## Decision
1. **Strict Artifact & Code Binding in Release Dossiers**:
   - Agent-generated sign-off files are forbidden; only named human operators may generate `evidence/dossier-signoff.json` via `sign-dossier.ts`.
   - `build-dossier.ts` hashes `coreEvidencePayload` (including `commitSha` and optional `imageDigests`) into `dossierHash` and automatically invalidates any sign-off whose `dossierHash`, `commitSha`, `imageDigests`, non-empty `scope`, or `expiresAt` (`<= 90` days) fails validation, reverting `status` cleanly to `"READY FOR REVIEW"`.
2. **SLO Manifest Honesty**: `ops/slo-manifest.v1.yaml` marks placeholder signatures `verified: false` (`"PENDING_MEASURED_EVIDENCE"`) until measured against live PostgreSQL + HTTP (`test-load:http` / `measure-restore`).
3. **Container Digest Pinning & Unprivileged Execution**:
   - `backend/Dockerfile` and `frontend/Dockerfile` pin immutable multi-arch SHA-256 base digests (`node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944` and `nginx:1.27.4-alpine@sha256:4ff102c5d78d254a6f0da062b3cf39eaf07f01eec0927fd21e219d0af8bc0591`).
   - `.dockerignore` excludes `.git`, `.env*`, `node_modules`, `dist`, and `evidence` at root, backend, and frontend contexts.
   - `frontend` runs as unprivileged `USER nginx` listening on port `8080` (`nginx.conf` + `docker-compose.yml` port `5173:8080`).
