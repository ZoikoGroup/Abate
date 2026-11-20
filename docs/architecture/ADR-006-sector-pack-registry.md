# ADR-006: Sector Pack Registry (Abate for Every Sector)

- **Status:** DRAFT (Pending Product & Architecture Owner sign-off). Supersedes section 2 of `ADR-005-ai-quota-and-sector-neutrality.md`.
- **Date:** 2026-11-19
- **Owners:** Platform Architecture & Governance

## Context
ADR-005 framed Abate as sector-neutral with the UK Legal Sector Pack as the only wired pack. In practice the legal pack was hard-coded: three fixed sector keys, a database check on those keys, legal-named routes and screens, and a legal-shaped flag that gated the UI. Adding any other sector meant code changes in the resolver, the routes, the database and the frontend.

## Decision
1. **Packs are data.** A sector pack is a validated definition (`backend/src/domains/lifecycle/sector-pack.ts`) registered in `sector-registry.ts`. It supplies vocabulary, work-item fields, units, jurisdictions, demand windows, the fatigue rule, forbidden fields, required gates, notice wording and screen wording. Adding a sector is one definition file and one registration line. `packs/README.md` lists the steps.
2. **The constitutional floor is enforced at registration.** A pack that lowers `privacyFloor` below 10, sets `aiAuthority` to `EXPANDED`, drops a core forbidden field, or carries unknown fields is rejected. Every pack inherits `substantiveWorkProduct`, `individualScore` and `keystrokeLogs` as forbidden and may only add more.
3. **Pack status is explicit.** `LAUNCHED` is a commercial pack with approved regulatory content. `PREVIEW` is a real sector pack whose regulatory content is pending the Legal & Policy Lead. `FIXTURE` is a portability test pack. `BASELINE` is the neutral core. Only `LAUNCHED` packs are counted as enabled or named in the product claim and the release dossier scope gate.
4. **Development does not author regulatory content.** Citations, statutory references and retention durations come from the Legal & Policy Lead. Packs without them use the sector-neutral ISO 45003 wording and stay `PREVIEW`.
5. **Generic routes, legal aliases.** `/api/v2/sector/work-items/*` serve whichever pack the tenant has. `/api/v2/sector/legal/*` remain as aliases for legal tenants and keep their original response shapes. `GET /api/v2/tenant/sector-profile` returns the pack's vocabulary, windows, units and screen wording, so clients render any sector without sector-specific code.
6. **Selection and resolution.** An explicit tenant setting wins. Without one, the sector is detected from policy bindings by whole-word match, in registration order. A stored sector that is no longer registered fails closed to the neutral baseline. Saving an unknown sector, or a pack key that belongs to another sector, is refused. The database keeps a format check on `sector_key` (migration 0086) instead of a fixed list.
7. **Records holds are sector-neutral.** The hold reference is `caseRef`. `matterRef` is accepted as a deprecated alias, and the stored column keeps its name until a safe migration.
8. **Enforcement.** `lint:sector-neutrality` fails CI when legal-only wording appears outside an allowlisted set of files, and fails when an allowlist entry goes stale.

## Consequences
- A new sector needs no resolver, route, migration or screen change.
- Preview packs let sectors be demonstrated without claiming regulatory coverage.
- The deprecated names (`hasLegalPack`, `LEGAL_PRACTICE` nav key, `matterRef`, legal alias routes) remain for one release and are removed afterwards.
- Fatigue thresholds for sectors with different shift patterns, such as clinical night shifts, are placeholders until reviewed. Healthcare's pack records this.
