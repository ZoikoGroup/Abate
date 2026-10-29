# Abate Decisions Register (B0 to B8)

This register tracks critical decisions across foundational packages B0 to B3 according to Playbook Section 23.

| Decision Area | Status | Why It Matters | Owner | Target Date | Resolution / Requirement |
|---------------|--------|----------------|-------|-------------|--------------------------|
| **Runtime, Cloud & Region** | Closed (B0) | Region and legal jurisdiction are separate axes | Platform Lead | 2026-10-28 | Node.js 24+ LTS; multi-tenant architecture; strict data residency per tenant region config. |
| **Separate DB Roles** | Closed (B0) | Owner role bypasses RLS in Postgres | Security Lead | 2026-10-28 | `abate_migrator` creates schema; `abate_app` runs with `NOSUPERUSER NOBYPASSRLS`. |
| **Source Vendors & Contracts** | Closed (B2) | Controls what data may ever enter system | Data Lead | 2026-11-15 | Allowlisted connectors only (starting with ZoikoTime); forbidden fields rejected before persistence. |
| **Initial Jurisdiction Packs** | Mechanism built (B5); content open | Claims must match legal coverage | Legal & Policy Lead | 2026-12-01 | Legal sector pack; effective-dated versioning; UK/EU psychosocial regulations. **Built:** versioned, effective-dated `jurisdiction_pack` catalog; no pack in effect ⇒ fail closed. **Open:** real pack content (only a synthetic test pack exists). See `ABATE_PHASE5_RETENTION_AND_JURISDICTION_REPORT.md`. |
| **Metric & Quality Definitions** | Open (B3) | Phase 3 cannot start without approved metric | Metrics Lead | 2026-11-20 | Boundary intrusion share metric; interval union; golden fixture validation. |
| **Privacy Profile & Thresholds** | Closed (B3) | Prevents individual re-identification | Privacy Lead | 2026-11-20 | Cohort size $n \ge 10$ for Class B/C; symmetric difference $<5$ overlap suppression; disclosure ledger. |
| **Retention Schedules** | Mechanism built (B5); durations open | No universal duration invented by dev | Compliance Lead | 2026-12-05 | Tenant-configurable retention classes; legal hold override; verified tombstone deletion. **Built:** all three, for `WORK_FACT`. No default duration. **Open:** tenant durations, and retention for governance records (audit, releases, evidence). |
| **SLO Workload Targets** | Instrumented & gated (B8); monthly measurement open | Performance baseline | SRE Lead | 2026-12-15 | Reads p95 $\le 500$ms, writes $\le 800$ms, released analytics $\le 1.5$s, 99.9% monthly availability. **Built:** per-request telemetry by route class, SLO report with error budget, `test-slo` load gate. **Open:** monthly availability and multi-instance p95 need external monitoring. See `ABATE_B8_SLO_AND_SUPPORT_REPORT.md`. |
| **Production Support Coverage** | Built (B8); IdP integration open | Zero-impersonation support model | Ops Lead | 2026-12-20 | Safe error logs only; no ad-hoc DB access; diagnostic receipts without raw data. **Built:** separate support credential refused on tenant routes; fingerprint-only error logs; signed tenant-issued diagnostic receipts; request lookup by id. **Open:** issue support credentials from the IdP under a separate key. |

