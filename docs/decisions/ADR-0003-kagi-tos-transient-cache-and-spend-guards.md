# ADR-0003: Kagi ToS posture — transient-only results, no /extract, spend guards

- Status: Accepted (pending owner sign-off on design doc)
- Date: 2026-11-14
- Deciders: Janni (owner), Hermes agent (designer)

## Context

Kagi v1 API (verified 2026-11-13/14 against live pages): `POST https://kagi.com/api/v1/search`, Bearer, **$12/1k**; API ToS (eff. 2026-09-22) prohibits storing/caching Results "beyond the transient caching needed to operate your application", prohibits redistribution as a product, allows internal agent use incl. feeding LLMs; invoicing at $100 or 30 days. wigolo's nature — caches: search results (`cacheSearchResults`, `core/core-provider.ts:776`), fetched page content, research artifacts — collides with #1; metered pricing collides with unbounded agent loops and forced probes.

## Decision Options

1. **Guarded adoption (chosen)**:
   - Kagi Results in-memory ≤60 s only; zero writes to the persistent result cache (choke-point guard at `cacheSearchResults` keyed on `transientResultsOnly` engine flag). **Scope note (gate finding B1):** no in-memory search-result tier exists today (store is SQLite-only, `CACHE_TTL_SEARCH=86400`), so building the ≤60 s tier is part of *this* decision, not a follow-up; `QS-6b` (t+59 s served from memory, t+61 s re-dispatched) is the falsifier.
   - Kagi `/extract` never called (page fetching stays on wigolo's own fetch/content-cache path — fetched page content is *not* Kagi Results);
   - persisted artifacts (smoke/acceptance JSONs, run notes) store **counts + verdicts, never result bodies**;
   - spend guards (`QS-6e`): `WIGOLO_KAGI_DAILY_BUDGET_USD` (default `1.0`) enforced with **pre-increment predicate `spent + cost ≤ budget`** (cost `$0.012/query` = the one pinned constant), ledger **shared across both roster instances and persisted outside process memory** (an in-process counter is 2× understated — kagi joins general+news — and restart-resettable, which amplifies exactly under OOM); exceeded → engine returns `[]` + warn once per cap event; auth-failure circuit (3×401 → 15 min park, caught inside the engine so breakers stay clean); kagi excluded from forced probes.
   - **Metered parity (gate MAJOR):** every metered engine — **brave as well as kagi** — gets forced-probe exclusion and spend caps; a sustained collapse would otherwise bleed brave's quota at up to 8,640 forced probes/engine/day.
2. Ignore the ToS nuance and let the **24 h** SQLite result cache (`config.ts:648`; an earlier draft said "20-min" — wrong by ~72×) serve Kagi hits: cheap convenience, clear contract breach for a commercial use — rejected.
3. Skip Kagi, stay free-engine-only: leaves the reliability gap REQ-1/2 only half-close (brave helps, single index).

## Consequences

- Positive: defensible under ToS; budget bounded at ≤ `WIGOLO_KAGI_DAILY_BUDGET_USD`/day (~$30/mo at default) **only under the shared persistent pre-increment ledger above** — without it the claim is not derivable; bad keys fail fast, not slowly.
- Negative: kagi-in-mixed-pool means the merged result is transient for everyone (the **24 h** cache hit-rate is lost on those queries) — accepted, recorded; mixed-pool caching granularity is future work.
- Neutral: smoke/acceptance evidence loses result bodies; verdicts + counts + engine telemetry remain sufficient for the audit trail.
