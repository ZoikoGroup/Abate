# ADR-000: TypeScript / Node Monorepo Architecture for Abate

**Status:** ACCEPTED  
**Owner:** Architecture Team  
**Date:** 2026-10-28  

## Context
Playbook ZAB-ENG-001 specifies a modular Django monolith. The engineering team has elected to implement a unified TypeScript stack with Node/Express/Next.js for both frontend and backend to share schemas, types, and client contracts directly. The playbook permits stack deviations provided they are recorded as architecture decisions and enforce identical isolation and safety guarantees (package B0).

## Decision
- **Runtime:** Node.js 24+ LTS, TypeScript throughout with strict compiler configuration (`noUncheckedIndexedAccess`, `strict`, `exactOptionalPropertyTypes`).
- **Backend Architecture:** Modular domain structure (`platform`, `domain-tenant`, `domain-ingest`, `domain-work`, `domain-measure`, `domain-privacy`, `contracts`, `worker`, `fixtures`).
- **Database & Isolation:** PostgreSQL source of truth with forced Row-Level Security (`ENABLE` and `FORCE ROW LEVEL SECURITY`), transaction-local tenant context (`withTenant`), and separate database credentials for migrator vs restricted app runtime (`abate_app` NOSUPERUSER NOBYPASSRLS).
- **Reliability:** Idempotent command pipeline (`runCommand`), append-only audit trail (`audit_event`), and transactional outbox (`outbox_event`) with background drainer worker (`drainOnce`).
- **Constitutional Guardrails:** Fail-closed tenant isolation, zero individual scoring or tracking, strict privacy gate (Class B/C n>=10 threshold and overlap rules), channel parity, and optional bounded AI.

## Alternatives Considered
- **Django as specified:** Provided built-in admin and migrations, but lacks end-to-end type sharing with TypeScript frontends.
- **Fastify/NestJS microservices:** Premature complexity for the first vertical slice (Phases 0–4).

## Consequences
- We provide explicit PostgreSQL migration tooling, transaction/RLS helpers (`withTenant`), command idempotency, outbox publishing, and domain boundary enforcement ourselves.
- Cross-domain imports are strictly prohibited; route handlers remain thin wrappers calling domain commands.

## Reversibility
Domain logic lives in decoupled domain packages/modules with public contracts, independent of HTTP transport or frameworks.

## Acceptance Evidence
- Phase 0 foundation boot, task runner (`bootstrap`, `migrate`, `seed-demo`, `test-fast`, `test-boundaries`, `demo-cycle`).
- Phase 1 isolation tests pass under restricted `abate_app` role; cross-tenant read is denied.

