# ADR-0001: In-tree Kagi engine + config-driven engine disable

- Status: Accepted (pending owner sign-off on design doc)
- Date: 2026-11-14
- Deciders: Janni (owner), Hermes agent (designer)

## Context

We want wigolo to use Kagi and to be able to turn off engines (bing, bing_news, marginalia, ddg) that fail or misbehave. Verified facts: wigolo has **no** Kagi support anywhere; **no** engine on/off config surface exists at prod tag or upstream (absence greps re-run 2026-11-14); pool rosters are hardcoded arrays (`verticals/general.ts:27-59`, `news.ts:37-77`); plugin engines at our tag never receive `search` queries (fixed upstream only in `cba8623c`, PR #693 — not in our base); SearXNG never joins the `core` provider at all.

## Decision Options

1. **In-tree fork change**: new `KagiEngine` + `WIGOLO_DISABLE_ENGINES` parsed in `config.ts`, filtered in the two vertical builders. *(chosen)*
2. Plugin engine + rebase onto upstream ≥ `cba8623c`: no rebuild, but built-ins can't be removed (only per-request `search_engines` allowlist) and the rebase ritual belongs to the Mac session — a cross-machine dependency for a halo-local fix.
3. SearXNG sidecar: env-only but a trap — under default `WIGOLO_SEARCH=core` the core provider never reads it; `/health` would turn green while nothing changes.

## Consequences

- Positive: true operator control in one place; breaker/telemetry integration comes free via `wrapWithRetryAndBreaker`; ships through the owner-gated pipeline we already trust.
- Negative: two more fork commits to maintain across upstream rebases; when the fork next rebases past `cba8623c`, revisit migrating Kagi to the plugin mechanism (recorded tech debt).
- Neutral: engine disable applies to `general`+`news` only for now; other verticals follow the same pattern later if needed.
