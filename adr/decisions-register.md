================================================================================
ABATE DECISIONS REGISTER (B0 TO B8)
================================================================================

This register tracks critical decisions across foundational packages B0 to B8 according to Playbook Section 23.

| Decision Area | Status | Why It Matters | Owner | Target Date | Resolution / Requirement |
|---------------|--------|----------------|-------|-------------|--------------------------|
| **Runtime, Cloud & Region** | Closed (B0) | Region and legal jurisdiction are separate axes | Platform Lead | 2026-10-28 | Node.js 20+ LTS; multi-tenant architecture; strict data residency per tenant region config (ADR-000). |
| **Separate DB Roles** | Closed (B0) | Owner role bypasses RLS in Postgres | Security Lead | 2026-10-28 | `abate_migrator` creates schema; `abate_app` runs with `NOSUPERUSER NOBYPASSRLS`; `abate_worker` restricted to outbox/inbox. |
| **Source Vendors & Contracts** | Closed (B2) | Controls what data may ever enter system | Data Lead | 2026-11-15 | Allowlisted connectors only (ZoikoTime v1.0); forbidden fields rejected before persistence; identity map isolation. |
| **Privacy Profile & Mechanism** | Closed (B3) | Prevents individual re-identification and ensures audit reproducibility | Privacy Lead | 2026-11-12 | Deterministic Cohort Boundary Protection: contributor floor k >= 10, symmetric difference Delta >= 5, residual Delta >= 5, advisory lock serialization. Laplace noise explicitly rejected (ADR-003). |
| **Metric & Quality Definitions** | Closed (B3) | Deterministic arithmetic without floating point drift | Metrics Lead | 2026-11-12 | Boundary intrusion share metric; interval union calculation; golden baseline validation; lineage digest tracking. |
| **Hazard & Control Governance** | Closed (B4) | Formal state machine and version-bound approvals | Safety Lead | 2026-11-12 | BE-007 state machine; version-bound approvals; material hash invalidation; automated transfer-of-risk detection; two-plane non-contamination (ADR-004). |
| **Initial Jurisdiction Packs** | Closed (B5) | Claims must match legal coverage | Legal & Policy Lead | 2026-11-12 | Effective-dated immutable jurisdiction packs; fail closed if outside coverage window; sequential versioning (ADR-005). |
| **Retention Schedules** | Closed (B5) | No universal duration invented by dev | Compliance Lead | 2026-11-12 | Tenant-configurable retention classes bounded by pack floor/ceiling; legal hold override; verified cryptographic tombstones; anti-resurrection guards (ADR-005). |
| **SLO Workload Targets** | Instrumented & gated (B8); monthly measurement open | Performance baseline | SRE Lead | 2026-12-15 | Reads p95 <= 500ms, writes <= 800ms, released analytics <= 1.5s, 99.9% monthly availability. **Built:** per-request telemetry by route class, SLO report with error budget, `test-slo` load gate. **Open:** monthly availability and multi-instance p95 need external monitoring. |
| **Production Support Coverage** | Built (B8); IdP integration open | Zero-impersonation support model | Ops Lead | 2026-12-20 | Safe error logs only; no ad-hoc DB access; diagnostic receipts without raw data. **Built:** separate support credential refused on tenant routes; fingerprint-only error logs; signed tenant-issued diagnostic receipts. **Open:** issue support credentials from IdP under separate key. |
