# Zoiko Abate — Phase 2 Architecture & Testing Guide

This folder provides complete documentation for **Phase 2 (Ingestion & Work-State Ledger)** of the Zoiko Abate platform.

The comprehensive guide is available in:
- [PHASE2_ARCHITECTURE_EXPLANATION_AND_VERIFICATION_GUIDE.md](../docs/phase2-architecture/PHASE2_ARCHITECTURE_EXPLANATION_AND_VERIFICATION_GUIDE.md)

---

## Quick Summary

### 1. What is Phase 2?
Phase 2 implements **Domain S02 (Ingestion)** and **Domain S03 (Work-State Ledger)** from architectural specification `ZAB-ENG-001 v1.0`. It allows organizations to ingest workforce operational activity (time records, intervals) **without overcollecting surveillance data** (screenshots, web history, keystrokes, personal health reasons).

### 2. Why are we using these specific patterns?
- **Allowlisted Connectors (`.strict()`):** Front-gate rejection of unapproved fields before data touches disk or memory.
- **Physical Minimization:** Surveillance decoys (`screenshotUrl`, `sickReason`) leave **0 trace** in databases, receipts, or logs.
- **Tenant-Scoped HMAC Pseudonymization:** `HMAC_SHA256(subject_id, tenant_secret)` prevents cross-tenant tracking and protects worker privacy while preserving work design analysis.
- **Append-Only Ledger Revisions:** Updates never mutate or overwrite past rows; higher revisions (`revision: 2`) are appended for immutable auditability.
- **Time-Derived Freshness:** Connection lag > 3x cadence evaluates to `STALE` so source outages are never mistaken for "zero work" or "zero risk".
- **Transactional Outbox:** Emits `work.facts.changed` within the same database transaction.

### 3. Why is everything built in Next.js / TypeScript only?
- **Shared Zod Contracts:** Same schema used by frontend forms, API boundaries, and database mappers. Zero drift.
- **Zero-Impedance Runtime:** Eliminates JSON parsing and date serialization discrepancies between disparate language runtimes.
- **OpenSSL Native Cryptography:** `node:crypto` provides sub-millisecond HMAC hashing without external microservice hops.
- **React 19 & Next.js Ecosystem:** Native integration with Next.js App Router, Server Components, and Server Actions.
- **Unified Security Boundary:** Single-engine enforcement of PostgreSQL Row-Level Security (`SET LOCAL abate.current_tenant_id`) and Bearer token claims.

### 4. How to run tests and check everything
- **Automated Tests:**
  ```bash
  npm --prefix backend run test-boundaries
  ```
  *(Verifies all 11 boundary tests across Phase 0, 1, and 2).*

- **Start System:**
  ```bash
  # Terminal 1: Backend
  cd backend && npm start

  # Terminal 2: Frontend
  cd frontend && npm run dev
  ```

- **Open UI:** Navigate to `http://localhost:5173` and click the **"Ingestion & Work Ledger (Phase 2)"** tab to access the live interactive test suite.

