# Abate Source Conflict & Constitutional Boundaries Register

**Owner:** Architecture & Compliance Owners  
**Baseline Specification:** Zoiko Abate Engineering Playbook (ZAB-ENG-001 v1.0) & ZAB-ARCH-001 / ZAB-BE-001–010  
**Updated:** 2026-10-28  

## 1. Recorded Architecture Conflicts

| Conflict ID | Source Conflict | Governing Rule | Decision & Enforcement |
|-------------|-----------------|----------------|------------------------|
| **CONF-001** | Legacy Practice / Clinical Vault wording references in early draft documents | ZAB-ARCH-001 and BE-008 | **Govern: No Vault dependency, no clinical screening, therapeutic chat, or clinical pathway in Abate v1.0.** System strictly measures organizational work conditions at cohort level. |
| **CONF-002** | Two Value Planes separation (Risk Assurance vs Work-Design Outcomes) | Section 2.2 | **Plane B (Work-design outcomes) can NEVER change, close, or downgrade a Plane A (Risk assurance) obligation.** Faster work or better financials is not evidence a hazard is controlled. A named human must review verification evidence. Separate write commands, permissions, and tests enforce this. |
| **CONF-003** | Individual inference vs Cohort measurement | Constitutional Boundary | **Zero individual scoring, ranking, psychosocial rating, or automated individual employment decisions.** Hard stop rule: escalate any feature requirement requesting individual inference. |
| **CONF-004** | Privacy bypass requests | Section 2.3 | **No customer-admin, employer, or support bypass of Privacy Release.** Channel parity: Dashboard, CSV, API, webhook, support, and AI all receive the identical released artifacts. |

## 2. Non-Negotiable Constitutional Boundaries

1. **No Individual Scores:** No individual psychosocial, mental-health, performance, or employability score; no worker ranking; no automated individual employment decision.
2. **No Surveillance / Content Mining:** No screenshots, keystrokes, URLs, application names, communication content, legal work product, medical reasons, or emotion recognition in analytics.
3. **No Clinical Path:** No clinical screening, treatment, therapeutic chat, or private-Vault dependency in v1.0.
4. **No General Model Training:** No general model training on identifiable customer workforce data; no bypass of Privacy Release.
5. **Fail Closed:** If privacy, tenant isolation, or policy safety cannot be established, deny immediately. Never lower privacy to restore availability.
6. **Bounded AI:** AI is proposal-only (explain and draft). Every workflow must complete with AI disabled. AI output never mutates authoritative state directly.

