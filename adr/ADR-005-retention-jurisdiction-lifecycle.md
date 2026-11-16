================================================================================
ADR-005: RETENTION AND JURISDICTION PACK ENFORCEMENT (BE-006)
================================================================================

STATUS: ACCEPTED  
OWNER: Compliance & Legal Architecture Team  
DATE: 2026-11-12  
FRAMEWORK STANDARD: ZAB-ENG-001 v1.0 & Specification ZAB-BE-006 (Domains S04 & S06)

--------------------------------------------------------------------------------
CONTEXT
--------------------------------------------------------------------------------
Work-fact records, timesheets, communication metadata, and derived metrics contain sensitive employment and workplace design data subject to strict data minimization mandates (GDPR Article 5(1)(e), UK Data Protection Act 2018, SRA Standards & Regulations, and international labor standards).

Systems handling workplace data frequently suffer from four critical compliance failures:
1. Hardcoded Platform Retention Defaults: Systems invent arbitrary retention durations (e.g. 90 or 365 days) without legal basis, creating regulatory liability for unlawful retention or unauthorized destruction.
2. Unbound Regulatory Authority: Organizations operating across multiple jurisdictions or sectors apply outdated or unverified legal rules without cryptographic provenance.
3. Spoliation of Evidence: Automated purge cron jobs delete records subject to active workplace dispute litigation or formal regulatory investigations.
4. Zombie Resurrections & Leaky Tombstones: Deleted records reappear when legacy connectors re-sync historical batches, or tombstones retain personal employee identifiers in audit logs.

--------------------------------------------------------------------------------
DECISION
--------------------------------------------------------------------------------
Zoiko Abate officially standardizes on Specification ZAB-BE-006: Retention & Jurisdiction Pack Enforcement across the entire data lifecycle.

1. EFFECTIVE-DATED IMMUTABLE JURISDICTION PACKS:
- All legal rules, retention constraints, and risk citations are encapsulated in versioned, content-hashed jurisdiction packs (`policy_pack` table) published solely by accountable Legal & Policy reviewers.
- Tenants bind to jurisdiction packs via `tenant_policy_binding`.
- Pack resolution is effective-dated (`effective_from` to `effective_to`):
  * Exactly one approved jurisdiction pack must cover the observation timestamp `at`.
  * If zero packs cover the date, resolution fails closed with `NOT_COVERED`.
  * If multiple overlapping packs are detected, resolution fails closed with `NOT_COVERED`.
  * The boundary timestamp belongs strictly to the newer version.
- Pack versions are strictly sequential and immutable: publishing an out-of-sequence version, altering approved content, or overlapping an existing active version is rejected with `CONFLICT`.

2. ZERO INVENTED RETENTION DEFAULTS:
- The platform never provides or assumes a default retention schedule.
- In the absence of an explicit, tenant-configured, active retention class for a given data category (`WORK_FACT`, `DISCLOSURE_RECORD`, `INCIDENT_RECORD`), retention runs delete zero rows and return receipt status `NO_POLICY`.

3. BOUNDED RETENTION DURATIONS:
- Tenant retention classes must be set by an authenticated `RISK_OWNER` or `EMPLOYER_ADMIN`.
- Duration (`retention_days`) must fall strictly within the floor and ceiling defined in the active jurisdiction pack:
  * Minimum floor: pack floor (and system floor >= 28 days for metric measurement validity).
  * Maximum ceiling: pack ceiling (e.g. statutory limitation periods).
- Configurations outside these bounds, or attempted without an active jurisdiction pack, fail closed with `VALIDATION`.

4. LEGAL HOLD OVERRIDE PROTECTIONS:
- An active legal hold (`legal_hold` with `released_at IS NULL`) unconditionally overrides retention purging.
- Holds can be scoped to a specific connection or apply tenant-wide across a data category.
- Purge accounting reconciliation invariant:
  * `eligible = purged + held`
  * Every purge run receipt precisely accounts for eligible, held, and purged items without exposing underlying record content.
- Releasing a legal hold records accountable principal, timestamp, and formal release reason. Double-release attempts fail closed with `CONFLICT`.

5. CRYPTOGRAPHIC TOMBSTONES AND RE-READ VERIFICATION:
- Prior to row deletion, a `deletion_tombstone` is inserted containing cryptographic hashes:
  * `record_digest = sha256Hex(canonicalJson(fact))`
  * `record_key_digest = HMAC(tenant_secret, connectionId:sourceRecordId:revision)`
  * Zero employee pseudonyms, source IDs, or raw timestamps are stored in the tombstone.
- Immediate re-read verification: after issuing `DELETE FROM work_fact_revision`, the runner re-queries by ID. If any target ID still resolves, an `UNAVAILABLE` error is raised and the transaction is rolled back.
- Storage-layer purge guard: direct SQL `DELETE` calls without an accompanying tombstone or targeting rows under active legal hold are aborted by storage guards.
- Anti-resurrection guard: if an external connector re-submits a previously purged record, ingestion recognizes the tombstoned `record_key_digest` and marks the item `DUPLICATE` (accepted: 0, duplicate: 1).

--------------------------------------------------------------------------------
CONSEQUENCES
--------------------------------------------------------------------------------
- Full compliance with legal preservation orders and GDPR erasure verification standards.
- Regulatory audits can verify that data destruction occurred on schedule without retaining any identifiable data in tombstones.
- Litigators and regulators receive verifiable cryptographic proofs of non-tampering and timely preservation.

