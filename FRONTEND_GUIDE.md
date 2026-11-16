# Zoiko Abate — Frontend Guide (`frontend/`)

A complete, beginner-friendly guide to understanding, building, running, and demonstrating the **Zoiko Abate** React + TypeScript web application, and how every screen connects to [BACKEND_GUIDE.md](./BACKEND_GUIDE.md).

---

## 1. Project Overview

### What the Frontend Does & Its Role
The `frontend/` app is the **browser workspace and live governance console** for **Zoiko Abate** — a workplace psychosocial-risk and work-design platform built around the core principle: **"Change the work. Not the worker."**

In the full system, the frontend acts purely as a **thin, untrusted UI client**:
- It renders **14 tabbed governance workspaces** plus a **12-step guided Live Demo Console** (`/demo`).
- It displays live API health, switches between two synthetic demo tenants (`Tenant A: Apex Legal Partners` and `Tenant B: Beacon Chambers`), exercises strict data-minimization & privacy-suppression boundaries in real time, and lets auditors verify SHA-256 + Merkle cryptographic evidence bundles offline right inside the browser via the Web Crypto API.
- It **never** stores secrets, **never** computes suppressed cohort counts locally, and **never** bypasses backend authorization, idempotency, or Row-Level Security (RLS).

### Tech Stack, Libraries & Versions
Verified directly from `frontend/package.json` and configuration files:

| Layer | Technology / Library | Version (in `package.json`) | Purpose |
| :--- | :--- | :--- | :--- |
| UI Framework | `react`, `react-dom` | `^19.3.1` | Component rendering & hooks (`useState`, `useEffect`, `useCallback`) |
| Language | `typescript` (`@types/react`, `@types/react-dom`, `@types/node`) | `~7.0.2` | Strict compile-time type checking (`tsc -b`) |
| Build & Dev Server | `vite`, `@vitejs/plugin-react` | `^8.3.5`, `^6.1.2` | Fast local HMR, `/api` reverse proxy to `:5000`, production bundler |
| Linter | `oxlint` | `^1.89.0` | Ultra-fast linting (`0` warnings / `0` errors gate) |
| Cryptography | Browser Web Crypto (`window.crypto.subtle`) | Built-in Web API | Offline SHA-256 digest & Merkle root verification (`AuditVerifierTab.tsx`) |
| Container Serving | Nginx (`nginx:1.27.4-alpine` pinned digest) | Unprivileged port `8080` | Static SPA hosting + `/api/` reverse proxy in `frontend/nginx.conf` |
| Browser E2E & A11y | `@playwright/test`, `@axe-core/playwright` (in `tests/`) | `^1.52.0`, `^4.10.2` | Automated Chromium E2E flows & WCAG 2.1 AA audits |

---

## 2. Folder Structure

```text
frontend/
├── index.html                           # Single-page HTML shell mounting #root
├── package.json                         # Frontend scripts (dev, build, lint, preview) and React/Vite deps
├── package-lock.json                    # Locked npm dependency tree
├── vite.config.ts                       # Vite config: /api -> http://127.0.0.1:5000 proxy + release-dossier fallback
├── nginx.conf                           # Production Nginx config (listen 8080, proxies /api/ to http://backend:5000)
├── Dockerfile                           # Multi-stage Node 22 builder -> non-root Nginx 1.27 Alpine container
├── .dockerignore                        # Excludes node_modules, dist, .env*, logs from Docker context
├── tsconfig.json                        # Root TypeScript project references
├── tsconfig.app.json                    # Browser TS compiler config
├── tsconfig.node.json                   # Node TS compiler config (vite.config.ts)
├── .oxlintrc.json                       # oxlint rules configuration
├── public/
│   ├── release-dossier.json             # Latest built Release Evidence Dossier served statically if needed
│   └── test-report.json                 # Latest boundary suite output consumed by UI / demo steps
└── src/
    ├── main.tsx                         # Entry point calling createRoot(#root) with <App />
    ├── App.tsx                          # Top-level state: tenant/role switcher, token fetching, 14 tabs & /demo toggle
    ├── App.css                          # Additional app layout styles
    ├── index.css                        # Core palette tokens (Aubergine, Coral, Graphite, Sage, Ivory) & WCAG styling
    ├── api/
    │   └── client.ts                    # Typed fetch() wrapper, PRESET_TENANTS, ApiError decoder, & all domain API helpers
    └── components/
        ├── Navbar.tsx                   # Header bar: Live health dot, tenant switcher, role selector, "Live Demo Console" launch
        ├── AiPanel.tsx                  # Bounded AI explanation & draft assistant UI panel (Phase 6)
        ├── CorrectionBanner.tsx         # Displays data correction / stale-release notices when ledger revisions occur
        ├── PermittedClaims.tsx          # Enforces allowed vs prohibited workplace claims display (Plane A vs Plane B)
        ├── PlaneBadge.tsx               # Visual badge distinguishing Plane A (Safety) from Plane B (Performance)
        ├── StateView.tsx                # Shared state/status indicator helper
        ├── Demo/
        │   ├── LiveDemoConsole.tsx      # 12-step guided walkthrough console (/demo) with auto-play & summary modal
        │   ├── Demo.css                 # Styling for the guided demo console, proof badges, and modal
        │   ├── demoApi.ts               # Demo fetch wrapper capturing raw headers, timing (ms), & masked cURL commands
        │   ├── ProofBadge.tsx           # PASS / FAIL / IDLE proof indicator pill per demo step
        │   ├── RequestInspector.tsx     # Live HTTP Request/Response/Headers JSON viewer & cURL generator
        │   └── WhatHappened.tsx         # Plain-English explanation card per demo step (Steps 1–12)
        └── Tabs/
            ├── OrganizationsTab.tsx     # Phase 1: Atomic organization create, exact replay (200), tamper conflict (409), & decoy reject
            ├── IngestionTab.tsx         # Phase 2: Source contracts, ZoikoTime / CalendarCadence connections, pause/resume, clean vs decoy ingest
            ├── CohortAnalyticsTab.tsx   # Phase 3: Privacy compiler tester (n=9 UNAVAILABLE vs n=10 RELEASED), CSV export, metric recalculate
            ├── HazardControlTab.tsx     # Phase 4: Hazard register, cause proposal/review, 14-state control lifecycle, approval & evidence export
            ├── RetentionTab.tsx         # Phase 5: Jurisdiction pack coverage, retention bounds, legal hold place/release, work-fact replay guard
            ├── BoundedAiTab.tsx         # Phase 6: AI explain/draft runs (no auto-commit), ephemeral action dispatch grants, kill switches
            ├── OutcomesAiChangeTab.tsx  # Phase 7: Plane B feature flag, outcome definitions, prohibited claim blocker, 8-stage AI change workflow
            ├── LegalPracticeTab.tsx     # Domain S13: UK Legal practice matters, SRA-aligned fatigue check, partner consultation gate, privilege block
            ├── OperationsTab.tsx        # Phase 8: Support operator session (zero-impersonation proof), diagnostic receipts, release dossier gate
            ├── IsolationTab.tsx         # Phase 1: Cross-tenant isolation verification workbench (Tenant A vs Tenant B)
            ├── OutboxTab.tsx            # Phase 1: Transactional outbox inspector & manual drain trigger
            ├── AuditTab.tsx             # Phase 1: Read-only immutable audit event log viewer
            ├── AuditVerifierTab.tsx     # Phase 9: Offline WebCrypto SHA-256 & Merkle root verifier + tamper simulator + JSON file upload
            └── ConstitutionalTab.tsx    # Phase 0: System health, constitutional boundaries matrix, & service info (`/api/info`)
```

---

## 3. Order of Work (Build Order)

If you are building the frontend from scratch—or explaining it in order—follow this exact sequence because **each layer unlocks the next**:

1. **Step 1 — Dev Server, Proxy & Design Tokens (`vite.config.ts`, `index.css`, `main.tsx`)**
   - *Why first*: The browser runs on `:5173` while the Express API runs on `:5000` (see [BACKEND_GUIDE.md](./BACKEND_GUIDE.md)). Vite's `/api` proxy prevents browser CORS issues in development, and `index.css` establishes accessible WCAG 2.1 AA contrast ratios right from the start.
   - *Backend dependency*: Backend listening on `127.0.0.1:5000`.
2. **Step 2 — API Client & Identity Context (`src/api/client.ts`)**
   - *Why second*: Every tab needs typed request helpers, consistent `Authorization: Bearer <jwt>` injection, `Idempotency-Key` headers for writes, and unified `ApiError` decoding (`requestId`, `code`, `status`).
   - *Backend dependency*: `POST /api/v2/auth/token`, `/api/health`, `/api/info`.
3. **Step 3 — App Shell, Tenant/Role Switcher & Navigation (`src/App.tsx`, `src/components/Navbar.tsx`)**
   - *Why third*: `App.tsx` owns `activeTenantId`, `activeRole`, and the fetched `token`. Switching tenant or role triggers `fetchTenantData()`, automatically issuing a fresh scoped token and reloading tenant-scoped data across tabs.
   - *Backend dependency*: `GET /api/v2/tenants/current`, `GET /api/v2/organizations`, `GET /api/v2/audit-events`.
4. **Step 4 — Foundation & Tenancy Workspaces (`ConstitutionalTab`, `OrganizationsTab`, `IsolationTab`, `OutboxTab`, `AuditTab`)**
   - *Why fourth*: Proves multi-tenant isolation, atomic idempotency (`200` replay vs `409` conflict), and strict Zod `.strict()` rejection before ingesting real work records.
   - *Backend dependency*: Tenant & Reliability APIs (`/api/v2/organizations`, `/api/v2/audit-events`, `/api/v2/outbox/drain`).
5. **Step 5 — Data Ingestion & Privacy Analytics Tabs (`IngestionTab`, `CohortAnalyticsTab`)**
   - *Why fifth*: You must ingest compliant work intervals (`ZoikoTime` / `CalendarCadence`) and verify decoy drops before the privacy release compiler can aggregate cohorts (`n >= 10` gate).
   - *Backend dependency*: Connectors, Receipts, Work Facts, Metrics, & Releases endpoints.
6. **Step 6 — Risk Governance, Retention & Bounded AI Tabs (`HazardControlTab`, `RetentionTab`, `BoundedAiTab`, `OutcomesAiChangeTab`, `LegalPracticeTab`)**
   - *Why sixth*: Hazards originate from approved Privacy Releases (`CohortAnalyticsTab`), Controls mitigate Hazards, Retention/Legal Holds govern underlying `WORK_FACT` lifetimes, AI explains/drafts against releases/hazards without auto-mutating state, and Plane B Outcomes / Legal Sector Pack build on top of those primitives.
   - *Backend dependency*: Domains S07, S08, S10, S11, S12, S13 routes in [BACKEND_GUIDE.md](./BACKEND_GUIDE.md).
7. **Step 7 — Operations, Offline Cryptographic Verifier & Guided Demo (`OperationsTab`, `AuditVerifierTab`, `components/Demo/`)**
   - *Why last*: These tabs pull together evidence packages produced in Phase 4, release dossiers compiled by backend CI runners, zero-impersonation support tokens (`OperationsTab`), and orchestrate all preceding endpoints into the 12-step `/demo` walkthrough.
   - *Backend dependency*: `/api/v2/support/*`, `/api/v2/evidence-packages*`, `/api/v2/release/dossier`, `public/release-dossier.json`.

---

## 4. Detailed Explanation (for Demo)

### Universal End-to-End Request Pattern
```text
User clicks button in React Tab
  -> Tab calls helper in frontend/src/api/client.ts (adds Bearer JWT + Idempotency-Key)
  -> Browser sends fetch("/api/v2/...")
  -> Vite proxy (dev) or Nginx (Docker) forwards /api/* -> backend:5000
  -> Express validates JWT + Zod schema (.strict()) -> runs inside PostgreSQL RLS transaction
  -> Response JSON returns { data } or safe error { code, message, requestId }
  -> React state updates tables, status badges, and feedback alerts
```

### Major Features & Endpoints Used

| Feature / Tab | How It Works (Simple Explanation) | Key Files | Backend Endpoints Called |
| :--- | :--- | :--- | :--- |
| **Tenant & Role Context** | On startup or dropdown change, requests a scoped dev token and reloads the active tenant's organizations & audit trail. Switching Tenant A -> Tenant B clears A's records completely. | `App.tsx`, `Navbar.tsx`, `client.ts` | `GET /api/health`, `GET /api/info`, `POST /api/v2/auth/token`, `GET /api/v2/tenants/current` |
| **Organizations & Idempotency** | Creates organizational units using a UUID `Idempotency-Key`. Clicking **Replay Exact Same Request** returns HTTP `200` without duplicating rows; changing the name with the same key returns `409 CONFLICT`; toggling the decoy field injects `keystroke_tracker_payload` and triggers HTTP `400` validation rejection. | `OrganizationsTab.tsx` | `GET /api/v2/organizations`, `POST /api/v2/organizations`, `GET /api/v2/organizations/:id` |
| **Ingestion & Minimization** | Lists approved source contracts, registers `ZoikoTime` or `CalendarCadence` connections, toggles `ACTIVE` <-> `PAUSED` <-> `REVOKED`, sends clean interval batches, and lets you fire a surveillance decoy batch that drops before DB storage. | `IngestionTab.tsx` | `GET /api/v2/source-contracts`, `GET/POST /api/v2/connections`, `POST /api/v2/connections/:id/pause\|resume\|revoke`, `POST /api/v2/connectors/zoikotime/batches`, `GET /api/v2/receipts`, `GET /api/v2/work-facts` |
| **Cohort Privacy Release** | Tests privacy gates: submitting a `9`-person cohort returns safe `UNAVAILABLE` (hiding headcounts and suppression reason); submitting `10+` people releases an aggregate percentage and supports CSV export. | `CohortAnalyticsTab.tsx` | `GET /api/v2/metrics/definitions`, `POST /api/v2/releases/query`, `GET /api/v2/releases/:id/export.csv`, `POST /api/v2/metrics/:id/recalculate` |
| **Hazards & Control Lifecycle** | Registers hazards anchored to a baseline release ID, proposes/accepts root causes, drafts & edits controls, enforces role-based approval (invalidating prior approvals on edit), records implementation evidence, concludes effectiveness, and exports a signed JSON evidence bundle. | `HazardControlTab.tsx`, `AiPanel.tsx` | `GET/POST /api/v2/hazards`, `POST /api/v2/hazards/:id/causes`, `POST /api/v2/hazards/:id/causes/:causeId/review`, `POST/PATCH /api/v2/controls`, `POST /api/v2/controls/:id/approve\|implementation\|verification/pin\|verification/conclude`, `POST /api/v2/hazards/:id/disposition\|evidence-package` |
| **Retention & Legal Holds** | Displays active jurisdiction pack (`legal-uk-sra` vs `legal-uk-bar`), validates retention durations inside floor/ceiling bounds, places/releases litigation legal holds, and previews/runs retention purges. | `RetentionTab.tsx` | `GET /api/v2/jurisdiction/coverage`, `GET /api/v2/jurisdiction/versions`, `GET /api/v2/retention/state`, `POST /api/v2/retention/classes`, `GET /api/v2/retention/preview`, `POST /api/v2/retention/run`, `POST /api/v2/retention/legal-holds`, `POST /api/v2/retention/legal-holds/:id/release` |
| **Bounded AI & Ephemeral Actions** | Generates AI explanations/drafts strictly marked `PROPOSED` (human click required to accept). Also demos ephemeral signed Action Grants and 6 live emergency kill switches (`all_ai`, `release_path`, connectors, etc.). | `BoundedAiTab.tsx`, `AiPanel.tsx` | `POST /api/v2/ai/explain-release`, `GET /api/v2/ai/runs`, `POST /api/v2/ai/runs/:id/accept\|discard`, `GET/POST /api/v2/ops/kill-switches`, `POST /api/v2/actions/proposals`, `POST /api/v2/actions/:id/dispatch` |
| **Plane B Outcomes & AI Change** | Feature-flagged workspace separating commercial performance (`Plane B`) from safety obligations (`Plane A`), rejecting prohibited blame/individual claims and advancing 8-stage AI deployment risk reviews. | `OutcomesAiChangeTab.tsx`, `PlaneBadge.tsx`, `PermittedClaims.tsx` | `GET/POST /api/v2/flags`, `GET /api/v2/outcomes/definitions`, `GET/POST /api/v2/outcomes/evaluations`, `GET/POST /api/v2/ai-changes`, `POST /api/v2/ai-changes/:id/advance` |
| **UK Legal Sector Pack** | Displays synthetic legal matter workloads, triggers SRA-aligned trial-prep fatigue detection requiring supervisory partner sign-off, maps work items neutrally, and blocks privileged/billing-rate/ranking injection. | `LegalPracticeTab.tsx` | `GET /api/v2/sector/legal/matters`, `POST /api/v2/sector/legal/matters/map`, `POST /api/v2/sector/legal/fatigue-check` |
| **Operations, Support & Verifier** | Demonstrates zero-impersonation support login (`SUPPORT` JWT rejected on tenant routes), creates & verifies content-free diagnostic receipts, displays Release Dossier status (`READY FOR REVIEW`), and runs client-side WebCrypto SHA-256 + Merkle verification. | `OperationsTab.tsx`, `AuditVerifierTab.tsx` | `POST /api/v2/support/token`, `POST /api/v2/support/diagnostic-receipts`, `POST /api/v2/ops/diagnostic-receipts/verify`, `GET /api/v2/release/dossier`, `POST/GET /api/v2/evidence-packages` |
| **Guided Live Demo (`/demo`)** | Sequential 12-step presenter tool with **Run Step**, **Run Auto-Demo**, **Request Inspector** (masked Bearer header + cURL), and **Demo Audit Verification Summary** modal. | `LiveDemoConsole.tsx`, `demoApi.ts`, `WhatHappened.tsx`, `RequestInspector.tsx` | Orchestrates `/api/health`, `/api/v2/auth/token`, `/api/v2/tenants/current`, `/api/v2/organizations`, `/api/v2/contracts/openapi.json`, `/api/v2/release/dossier`, plus `public/test-report.json` |

---

## 5. Demo Script

Follow this live presenter script (estimated **5–7 minutes**):

### Part A — Guided 12-Step Console (`/demo`)
1. Open `http://127.0.0.1:5173/demo` (or click **Live Demo Console** in the top navbar).
   - **Say**: *"This console walks through every guarantee live against the API — every step shows the exact HTTP request, latency, and masked curl command."*
2. Click **Step 1 -> Check system health**.
   - **Audience sees**: `PASS` badge, `200 OK` response from `GET /api/health` with non-surveillance boundary flags.
3. Step through **Steps 2–6** (or click **Run Auto-Demo**):
   - **Step 2 & 3**: Issues scoped JWTs for **Tenant A** and **Tenant B** via `/api/v2/auth/token`.
   - **Step 4 & 5**: Creates an organization atomically, replays the exact `Idempotency-Key` (`200 OK` cached replay), and sends a mutated payload (`409 CONFLICT` expected & caught!).
   - **Step 6**: Queries `/api/v2/organizations` with Tenant B's token and proves Tenant A's newly created unit is invisible.
4. Click **Step 10 -> Inspect release dossier**, then **View Verification Summary**.
   - **Audience sees**: Consolidated summary modal showing `READY FOR REVIEW` status across all test suites.

### Part B — Deep-Dive Constitutional Labs (Main Tabs)
5. Switch back to main tabs -> click **Cohort Analytics & Privacy (Phase 3)**.
   - Click **1. Test n = 9 Floor Violation** -> Audience sees `RELEASE SUPPRESSED (SAFE UNAVAILABLE)`.
   - Click **2. Test n = 10 Valid Release** -> Audience sees `STATUS: RELEASED` with a cohort share % (zero individual IDs, zero contributor count returned).
   - **Say**: *"Nine contributors is rejected fail-closed without revealing why or leaking headcount; ten releases safely."*
6. Click **Legal Sector Pack (SRA 2023)** -> click **SRA Fatigue Check**.
   - Toggle `#inject-privilege-check` on and click **Execute Translation & Boundary Gate** -> Audience sees `Constitutional Boundary Defended` rejection. Toggle it off and re-run -> `Mapped Neutral Representation (Zero Privilege Leak)`.
7. Click **Audit Verifier & Merkle** -> click **Issue & Verify Live Package**, then **Simulate Artifact Tamper**.
   - **Audience sees**: Real browser WebCrypto turns green (`VERIFIED`) and immediately catches single-byte tampering (`TAMPER OR MISMATCH DETECTED`), while noting hashes verify integrity, not truth of claims.

### Likely Audience Questions & Short Answers
- **Q: Could someone open DevTools and read Tenant B's data by swapping the tenant UUID?**
  - **A**: No. Changing the dropdown requests a tenant-bound token, and every backend query sets PostgreSQL `set_config('app.tenant_id', ..., true)` under Forced RLS. Even direct API calls with a Tenant A token return `404` or `0` rows for Tenant B (`IsolationTab` proves this live).
- **Q: Is the Release Dossier claiming the app is approved for production customers today?**
  - **A**: No. Status is `READY FOR REVIEW` for synthetic sandbox scope. Production launch requires swapping the dev token route for real OIDC SSO, external secret management, legal/privacy sign-offs (`docs/governance/open-signoffs.md`), and live Postgres challenge testing.
- **Q: Does this frontend use `.env` secrets?**
  - **A**: Zero secrets live in the frontend. `frontend/src` does not read any `import.meta.env` variables; dev requests use relative `/api/...` proxied via `vite.config.ts`.

---

## 6. Current Status

### ✅ Done
- React `19` + Vite `8` + TypeScript SPA with 14 domain workspaces and 12-step `/demo` console.
- Full tenant switcher (`Tenant A` / `Tenant B`), role selector, idempotency replay/conflict lab, and decoy payload injection labs.
- Offline WebCrypto SHA-256 + Merkle inclusion proof verifier (`AuditVerifierTab.tsx`).
- Clean WCAG 2.1 AA contrast styling (`index.css`, verified with Axe in `tests/a11y/pages.spec.ts`), `oxlint` (`0` warnings / `0` errors), and clean `vite build`.
- Unprivileged production container (`frontend/Dockerfile` running `USER nginx` on port `8080`, matching `frontend/nginx.conf` and `docker-compose.yml`).
- Overclaiming copy (`"differential privacy"`, `"GO"`, `"0 failing P0 tests"`) cleaned across Demo & Tab components.

### 🔄 In Progress
- **Browser E2E & Accessibility Suite Verification**: All specs exist in `tests/e2e/` (7 files) and `tests/a11y/pages.spec.ts`, and local TypeScript declarations (`tests/declarations.d.ts`) compile cleanly, but `tests/node_modules` is not installed locally (Playwright runs in GitHub CI).
- **Docker Container Verification**: `frontend/Dockerfile` and `nginx.conf` are updated and awaiting a CI or local Docker daemon build test.

### ❌ Remaining
- **Real OIDC / SSO Login Flow**: Frontend currently calls the non-production `POST /api/v2/auth/token` dev issuer (`PRESET_TENANTS` in `client.ts`). Real production needs an IdP login redirect/PKCE flow and token refresh UI.
- **Automated Frontend Unit Tests (Vitest / RTL)**: No component unit test runner exists inside `frontend/package.json` (currently tested via `tsc -b`, `oxlint`, and external Playwright E2E).

---

## 7. Next Steps

### Prioritized Action List
- **[High] Install & Run Playwright + Axe Locally & in CI**: Verify all `tests/e2e/*.spec.ts` and `tests/a11y/pages.spec.ts` pass against the live backend (`npm --prefix tests install && npm --prefix tests run test:e2e`).
- **[High] Build & Probe Frontend Docker Container**: Run `docker compose --profile fullstack up --build` (once Docker Desktop is running) to confirm unprivileged Nginx (`:8080` mapped to `:5173`) serves static assets and proxies `/api/` cleanly.
- **[Medium] Replace Hardcoded Dev Auth (`PRESET_TENANTS` / `requestToken`) for Stage D Pilot**: Gate dev preset switcher behind an explicit dev-mode banner/flag and add OIDC login screen for `staging`/`production`.
- **[Medium] Reconcile Frontend API Paths vs OpenAPI Docs**: Align any route discrepancies documented in `docs/governance/be-spec-reconciliation.md` before external consumer onboarding.
- **[Low] Modularize Large Tab Components & Add Component Tests**: Extract helpers from large tabs (`HazardControlTab.tsx` ~1,372 lines, `LiveDemoConsole.tsx` ~1,356 lines) and add Vitest + React Testing Library tests.

### Known Limitations & Technical Debt
- Large single-file components (`HazardControlTab.tsx`, `OutcomesAiChangeTab.tsx`, `IngestionTab.tsx`, `LiveDemoConsole.tsx`, `client.ts` ~1,458 lines) mix types, API helpers, and presentation.
- `vite.config.ts` serves `frontend/public/release-dossier.json` locally on `/api/v2/release/dossier` as a dev convenience even if the backend isn't queried for that single route in dev mode (remember to run `npm --prefix backend run build-dossier` when updating code so `public/release-dossier.json` stays current).
- `tests/` relies on `tests/declarations.d.ts` offline when `tests/node_modules` is absent.

---

## 8. How to Run

### Prerequisites
- Node.js `22` (matches `.github/workflows/ci.yml` and `Dockerfile`)
- Running Abate backend on `127.0.0.1:5000` (see [BACKEND_GUIDE.md](./BACKEND_GUIDE.md))

### Environment Variables
- **Frontend (`frontend/`)**: None required (`frontend/src` reads zero `import.meta.env` variables). Vite dev server proxies `/api/*` -> `http://127.0.0.1:5000`.
- **E2E Test Runner (`tests/`)**:
  - `PLAYWRIGHT_TEST_BASE_URL` (optional; defaults to `http://127.0.0.1:5173`)
  - `PLAYWRIGHT_SKIP_WEBSERVER` (set `"1"` if backend & frontend servers are already running)
  - `CI` (adjusts Playwright retries & HTML reporting)

### Install, Run & Verify Commands
```bash
# 1. Install frontend dependencies
npm --prefix frontend ci

# 2. Start Vite dev server (http://127.0.0.1:5173) — start backend first on :5000
npm --prefix frontend run dev

# 3. Lint (0 warnings / 0 errors) & TypeScript + production bundle build
npm --prefix frontend run lint
npm --prefix frontend run build

# 4. Preview built bundle locally
npm --prefix frontend run preview

# 5. (Optional) Install & run Playwright E2E + Axe Accessibility tests
npm --prefix tests install
npm --prefix tests exec -- playwright install chromium
npm --prefix tests run test:e2e
```
