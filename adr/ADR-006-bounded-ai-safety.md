================================================================================
ADR-006: BOUNDED AI ASSISTANCE AND SAFETY INTERVENTIONS (BE-008)
================================================================================

STATUS: ACCEPTED  
OWNER: AI Safety & System Integrity Architecture Team  
DATE: 2026-11-12  
FRAMEWORK STANDARD: ZAB-ENG-001 v1.0 & Specification ZAB-BE-008 (Domains S08 & S09)

--------------------------------------------------------------------------------
CONTEXT
--------------------------------------------------------------------------------
Integrating generative AI and machine learning into workplace psychosocial risk management introduces severe compliance, legal, and safety risks. Under the EU AI Act (Annex III High-Risk AI Systems in Employment & Worker Management) and UK Data Protection laws, automated systems cannot act autonomously, cannot evaluate individual worker performance or health, and must remain under meaningful human oversight.

Key operational vulnerabilities in generative AI systems include:
1. Hallucinated Metrics and Citations: LLMs inventing statistics or attributing findings to non-existent data sources.
2. Adversarial Prompt Injections: Injected instructions hidden within retrieved documents attempting to force personal data disclosure.
3. Automated Action Execution: Unverified agents directly triggering mutations or notifications without cryptographic validation of intended parameters.
4. Cascading Availability Failures: AI service outages or latency spikes bringing down manual compliance and hazard mitigation workflows.

--------------------------------------------------------------------------------
DECISION
--------------------------------------------------------------------------------
Zoiko Abate officially standardizes on Specification ZAB-BE-008: Bounded AI Assistance & Safety Interventions. The architecture strictly fences AI capabilities, verifies outputs through five deterministic gates, mandates cryptographic parameter grants, and provides instantaneous circuit breaking via independent kill switches.

1. CONSTITUTIONAL VALIDATION GATES (5 DETERMINISTIC GATES):
All candidate model outputs must pass five deterministic post-generation validation checks before reaching any API caller:
- Gate 1 (Schema Validation): Strict Zod parsing ensuring structural compliance with `AiProposalSchema`.
- Gate 2 (Prohibited Inference & Medical Refusal): Complete exclusion of individual performance, diagnostic, disciplinary, or personal identification terms. Pre-execution input screening rejects prompts seeking individual inference before invoking any model API.
- Gate 3 (Citation Guard): Every claim must explicitly cite an authorized context ID retrieved for that tenant. Unretrieved, external, or hallucinated citation IDs fail closed with `CITATION`.
- Gate 4 (Numeric Fidelity Validator): All numerical values appearing in claim text must equal released metric values or authorized parameters verbatim. Any statistical drift, rounding exaggeration, or invented figure fails closed with `NUMERIC_FIDELITY`.
- Gate 5 (Control Catalog Eligibility): Suggested hazard controls must exist within the immutable, approved control catalog (`APPROVED_CONTROL_CATALOG`).

2. CRYPTOGRAPHIC ACTION GRANTS & TAMPER GUARDS:
- AI models have zero direct execution privileges.
- Triggering an external action or notification requires an ephemeral, HMAC-signed `grantToken` binding:
  * `actor`: Authorized human principal initiating or approving the proposal.
  * `tool`: Exact registered tool identifier.
  * `target`: Scoped organization or system target.
  * `paramHash`: SHA-256 digest of normalized JSON parameters (`paramHashOf(params)`).
  * `approvalRef`: Immutable identifier of the governing human approval record.
- Any modification of action parameters between approval and dispatch invalidates the grant token and is rejected with `FORBIDDEN`.

3. DISTRIBUTED FENCING & TIMEOUT DISAMBIGUATION:
- Asynchronous action executions use monotonically increasing fencing tokens. Stale worker writes presenting outdated tokens are rejected at the database row level.
- Network timeouts or ambiguous provider responses transition attempts to `UNKNOWN_OUTCOME`. Automated blind retries are prohibited until reconciliation verifies whether external side-effects occurred.

4. INDEPENDENT KILL SWITCHES & MANUAL CONTINUITY:
- The system maintains five independent, database-backed kill switches:
  1. `all_ai`: Instant shutdown of all generative AI and explanation pipelines.
  2. `release_path`: Instant freeze on analytical release publishing.
  3. `connector:zoikotime`: Isolation of external ingestion feeds.
  4. `pack:legal-uk-sra`: Suspension of jurisdiction policy evaluations.
  5. `tool:ticket_notification`: Immediate cutoff of outbound action dispatches.
- Activating `all_ai` halts all AI endpoints with an immediate, graceful `UNAVAILABLE` code advising users to proceed manually.
- Manual psychosocial risk assessment, hazard investigation, control assignment, human approval, and verification workflows remain 100% functional during AI outages or kill-switch engagements.

--------------------------------------------------------------------------------
CONSEQUENCES
--------------------------------------------------------------------------------
- Guarantees compliance with High-Risk AI regulatory standards (human-in-the-loop, accuracy, robustness).
- Zero hallucinated numbers or fabricated citations can ever enter official audit evidence.
- Full operational resilience: organizations continue hazard mitigation even if AI components are offline.

