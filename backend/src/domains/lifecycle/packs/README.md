# Sector packs

A sector pack is data that maps one sector's vocabulary and demand windows onto the neutral work-design core.
Adding a sector needs one definition file here and one `registerSectorPack` line in `../sector-registry.ts`.
No resolver, route, database or screen change is needed.

## Add a sector

1. Copy the closest existing pack, for example `software-it.ts`, and rename it.
2. Set `sectorKey` (upper case, for example `EDUCATION`), `packKey`, `acceptedPackKeys`, and `bindingMatchers`.
   A tenant policy binding whose key contains one of the matchers as a whole word selects the sector automatically.
3. Author the vocabulary, `workItemFields`, `demandWindows`, `highDemandWindows` and the `fatigueRule`.
4. List `forbidden` fields: everything the sector must never ingest. Core fields (`individualScore`,
   `keystrokeLogs`, `substantiveWorkProduct`) are inherited automatically and cannot be dropped.
5. Optionally override screen wording with `ui`, and gate wording with `fatigueNotice`.
   Anything omitted is built from the vocabulary, citing only the sector-neutral ISO 45003 baseline.
6. Import it in `../sector-registry.ts` and add `registerSectorPack(...)`.
7. Run `npm run test-sector-registry`, `npm run test-sector-work` and `npm --prefix ../frontend test`.

## Status

| Status | Meaning | Counted as enabled |
| --- | --- | --- |
| `LAUNCHED` | Commercial pack. Regulatory content approved. Needs a `launchTag`. | Yes |
| `PREVIEW` | Real sector pack. Regulatory content pending policy review. | No |
| `FIXTURE` | Portability test pack. | No |
| `BASELINE` | The neutral core. Exactly one exists. | No |

## What a pack must not contain

- **Regulatory content that nobody approved.** Citations, statutory references and retention durations come from
  the Legal & Policy Lead, never from development. Without them the pack stays `PREVIEW`.
- **A lower privacy floor or wider AI authority.** The validator rejects both at registration.
- **Person names.** Packs ship no example people.

Retention is separate. A tenant with no approved jurisdiction pack for its sector has no retention policy, and
nothing is deleted until one is configured.
