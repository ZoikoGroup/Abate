# Abate — Phase 6: Bounded AI & Safe Action Execution

**Playbook package:** B6 (`Abate_Phase6_Bounded_AI_and_Actions.pdf`)
**Domains:** S08 Bounded AI (`backend/src/domains/ai/`) and S09 Action Execution (`backend/src/domains/actions/`)
**Date:** 30 October 2026
**Status:** Implemented and verified across all 8 adversarial labs and end-to-end demo cycle.

---

## 1. What the Specification Required

| Domain | Specification Requirement | Delivered |
|---|---|---|
| **S08 Bounded AI** | Deterministic assistance only; zero authoritative arithmetic; zero access to raw/protected measurement tables; prompt instructions are never a security boundary; manual cycle runs without AI. Output is strictly a `PROPOSED` draft. | Strict AI gateway executing after retrieval of released evidence (`RELEASE`) and approved knowledge (`KNOWLEDGE`). 6 output validators enforce deterministic invariants. Accept command writes human-governed draft into workflow. |
| **S08 Safety & Privacy** | Single read path: AI context retrieved strictly from `getRelease` (released evidence) and versioned knowledge catalog. Untrusted data contained within `<item id="...">` XML blocks. | Fail-closed context retrieval. Pre-call refusal for any prompt inquiring about individuals. Complete insulation from raw work facts or pseudonym rosters. |
| **S08 Multi-Level Kill Switches** | Granular kill switches (`use_case:<key>`, `model:<ref>`, `provider:<name>`, `tool:<name>`, `all_ai`) with immediate fail-closed shutdown and calm user fallback. | Memory & DB-backed kill switch registry. Sub-millisecond evaluation prior to model invocation returning safe `UNAVAILABLE` and user-friendly manual continuation guidance. |
| **S09 Safe Action Broker** | HMAC/JWT signed action grants bound to parameter SHA-256 hash (`param_hash`); atomic leases (`LEASED`); fencing tokens (`fencing_token + 1`); explicit `UNKNOWN_OUTCOME` on provider timeout without blind retries. | Cryptographic grant minting & verification catching parameter tampering; atomic dispatch leases with optimistic concurrency fencing; timeout handling logging `UNKNOWN_OUTCOME`. |

---

## 2. Invariants Enforced

1. **AI Output Is Strictly Proposed:** Proposals are tagged `PROPOSED`. Nothing the AI generates can approve, implement, or close an intervention or hazard without explicit human review and authoritative workflow commands.
2. **Deterministic Arithmetic Boundary:** The model is prohibited from calculating metrics or inventing figures. Every number emitted by the model must match a released value (`NUMERIC_FIDELITY` validator).
3. **No Individual Profiling:** Prompts seeking personal evaluation or output containing individual names, sentiments, or performance assessments are rejected with `PROHIBITED_INFERENCE`.
4. **Citation Grounding (No Hallucinations):** Every claim must reference a verified item ID in the retrieved context (`CITATION` validator).
5. **Prompt Injection Immunity:** Untrusted data is isolated in XML tags (`<evidence><item id="...">...`). System instructions and validators run independently of model output.
6. **Action Parameter Hash Binding:** Grants contain a SHA-256 hash of the intended tool parameters. Any mutation of parameters between proposal and dispatch results in immediate `403 FORBIDDEN`.
7. **Fencing Tokens & Atomic Leasing:** Worker dispatch updates the attempt state to `LEASED` with `fencing_token + 1`. Stale worker writes with mismatched tokens fail immediately.
8. **Ambiguous Provider Failures:** On dispatch timeout or network drop, the broker records `UNKNOWN_OUTCOME` and refuses automatic blind retries to prevent duplicate real-world actions.

---

## 3. Architecture & Files

### Backend
- `backend/db/migrations/0060_bounded_ai_actions.sql`: DDL for `ai_use_case`, `ai_run`, `ai_kill_switch`, `tool_catalog`, and `action_attempt` with forced tenant RLS.
- `backend/src/contracts/ai.ts`: Zod contracts for AI claims, proposals, run views, validation reports, and kill switch inputs.
- `backend/src/contracts/actions.ts`: Contracts for action grants, parameter-hash binding, and dispatch attempts.
- `backend/src/domains/ai/gateway.ts`: `ModelProvider` interface, budget tracking, and `DeterministicMockProvider`.
- `backend/src/domains/ai/retrieve.ts`: Fail-closed context retrieval strictly reading released evidence (`getRelease`) and approved knowledge.
- `backend/src/domains/ai/prompt.ts`: XML envelope data isolation separating trusted instructions from untrusted data items.
- `backend/src/domains/ai/validate.ts`: The 6 constitutional output validators (`SCHEMA`, `CITATION`, `NUMERIC_FIDELITY`, `PROHIBITED_INFERENCE`, `CONTROL_ELIGIBILITY`, `PROVIDER_REGION`).
- `backend/src/domains/ai/kill-switch.ts`: Multi-level kill switch checks (`assertNoKillSwitch`, `setKillSwitch`, `getKillSwitches`).
- `backend/src/domains/ai/run.ts`: End-to-end `runAiUseCase` execution pipeline with pre-call checks, model calls, validation, and audit recording.
- `backend/src/domains/ai/accept.ts`: Human-in-the-loop transition converting AI proposal into workflow items (`acceptAiRun`, `discardAiRun`).
- `backend/src/domains/actions/grant.ts`: Signed action grants with 120s TTL and parameter SHA-256 hash validation.
- `backend/src/domains/actions/dispatch.ts`: Atomic lease execution with fencing tokens and timeout recording.
- `backend/src/platform/db/with-tenant.ts`: Memory database support for AI and Action tables, RLS enforcement, and transactional queries.
- `backend/src/fixtures/seed.ts`: Default seed use-cases (`explain_release`, `draft_cause`, `draft_control`), tool catalog (`ticket_notification`, `roster_update`), and baseline releases.

### Frontend
- `frontend/src/api/client.ts`: Phase 6 API methods (`explainRelease`, `draftCause`, `draftControl`, `acceptAiRun`, `discardAiRun`, `fetchAiRuns`, `proposeAction`, `dispatchAction`, `fetchKillSwitches`, `toggleKillSwitch`).
- `frontend/src/components/AiPanel.tsx`: Accessible bounded AI assistance panel with plain-language uncertainty, expandable citations, validator badges, and human accept/discard workflow.
- `frontend/src/components/Tabs/BoundedAiTab.tsx`: Phase 6 management console featuring the 8-lab adversarial testing suite, action grant verification monitor, kill switch controls, and audit history.
- `frontend/src/components/Tabs/HazardControlTab.tsx`: Embedded `AiPanel` for assistive drafting of organizational causes and risk controls.

---

## 4. API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v2/ai/explain-release` | Grounded explanation of an approved privacy release |
| POST | `/api/v2/ai/draft-cause` | Propose organizational causes for an active hazard |
| POST | `/api/v2/ai/draft-control` | Draft eligible controls from the approved control catalog |
| POST | `/api/v2/ai/runs/:id/accept` | Human accepts AI proposal and creates domain workflow record |
| POST | `/api/v2/ai/runs/:id/discard` | Human explicitly discards AI proposal |
| GET | `/api/v2/ai/runs` | Audit history of AI runs for active tenant |
| GET | `/api/v2/ops/kill-switches` | List active kill switches across all scopes |
| POST | `/api/v2/ops/kill-switches` | Toggle kill switch (`use_case`, `model`, `provider`, `tool`, `all_ai`) |
| POST | `/api/v2/actions/proposals` | Propose external action and mint parameter-hash-bound grant |
| POST | `/api/v2/actions/:id/dispatch` | Dispatch external action verifying grant token and lease fencing |

---

## 5. Verification Results

### 8 Adversarial Labs (ZAB-ENG-001 B6 §8)
- **Lab 1 (Injection Resistance):** Injected instructions in knowledge attempting to disclose employee data are rejected by constitutional safety validators.
- **Lab 2 (Citation Grounding):** Model hallucinating an ungrounded citation ID is rejected by the `CITATION` validator.
- **Lab 3 (Numeric Fidelity):** Altered numbers not present in released context are rejected by `NUMERIC_FIDELITY`.
- **Lab 4 (Pre-Call Prohibited Guard):** Prompts attempting to score or infer individual performance are rejected before invoking the model.
- **Lab 5 (Action Grant Tampering):** Modifying action parameters after grant issuance fails signature verification with `403 FORBIDDEN`.
- **Lab 6 (Action Timeout Handling):** Provider execution timeout transitions attempt to `UNKNOWN_OUTCOME` without blind retries.
- **Lab 7 (Stale Worker Fencing):** Out-of-order execution with mismatched fencing tokens is rejected.
- **Lab 8 (Emergency Kill Switch):** Immediate shutdown when kill switch engaged; manual cycle remains operational.

### Test Suites Status
- Fast Unit Tests (`test-fast`): **9/9 Passing**
- Constitutional Boundaries (`test-boundaries`): **42/42 Passing**
- SLO & Support (`test-slo`): **6/6 Passing**
- Golden Demo Cycle (`demo-cycle`): **16/16 Steps Passing**
- Frontend Production Build (`vite build`): **Clean (30 modules, 0 errors)**

