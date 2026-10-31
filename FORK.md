# FORK.md — local changes vs upstream

Our fork: `randomm/wigolo` · upstream: `KnockOutEZ/wigolo` · license: AGPL-3.0 (+ commercial dual).

**Branch model**

- `main` — pure upstream mirror. Never commit here. Fast-forward:
  `git fetch upstream && git checkout main && git merge --ff-only upstream/main`
- `fix/*` — our divergences, rebased onto current `main`:
  `git checkout fix/... && git rebase main`
- One-time setup: `git remote add upstream https://github.com/KnockOutEZ/wigolo`

**Contribution posture:** upstream `CONTRIBUTING.md` auto-applies a CLA granting
the maintainer an irrevocable right to relicense any PR contribution for their
commercial offering. Default = keep fixes here, file upstream *issues* with
repros only. PRs require an explicit human decision each time.

## Divergences

### branch `fix/bing-soft-block-thin-pool-gate` (2026-10-31, commit `93d7485`)

| File | Change | Why | Merge-conflict risk |
|---|---|---|---|
| `src/search/engines/bing.ts` | New exported `looksLikeBaitSerp()`; `search()` drops bait SERPs (mean `lexicalAlignment` < 0.05 over ≥3 results) after one UA-rotation refetch | Bing intermittently serves cookieless scrapers HTTP-200 bait SERPs (verified 2026-10-31: prediction-market/telecom pages for a Node.js query). Parser fine; only relevance fake | medium — upstream touches bing retry/UA logic |
| `src/search/core/core-provider.ts` | Zero-lexical junk-floor gate fires on `thin_pool` too, not only `pool_collapsed` | Live incident was thin_pool-shaped (DDG rate-limited + bing bait, ≤2 contributors): collapse-only gate stayed inert, top-1 exemption surfaced confident junk, `research` snowballed it | low — one predicate, well-commented |
| `tests/unit/search/engines/bing-bait.test.ts` | New table-driven tests incl. live fixture | Locks bait shape; keeps fix honest across rebases | none (new file) |

After every rebase on upstream: `npx vitest run tests/unit/search/engines/bing-*.test.ts tests/unit/search/core/core-provider-score-floor.test.ts tests/unit/search/core/score-floor*.test.ts tests/unit/search/degraded-recovery.test.ts`

Known upstream gaps found while debugging (candidates for issue reports, no PRs):
1. `research` has no cache-bypass flag (`search` has `--force-refresh`); a
   poisoned local cache re-serves junk into synthesis indefinitely.
2. `hasTemporalIntent` misses "current stable <X> version" → no recency boost;
   stale v5/v6 release pages rank ~0.94 for current-version queries.

## Local runtime (outside the repo — not part of any merge)

- Global install is **this fork** (`npm install -g .` from a built checkout;
  build first: `npm run build`). Verify: `wigolo --version` + daemon path below.
- launchd `~/Library/LaunchAgents/com.trailopeners.wigolo.plist` runs
  `.../fnm/.../bin/wigolo serve --port 3333` (fork binary, not `npx -y wigolo`
  which resolves to the registry build). Env: b200 OpenAI-compatible endpoint,
  `WIGOLO_LLM_MODEL=qwen3.8-flash-next`. Backup of pre-fix plist:
  `com.trailopeners.wigolo.plist.bak-20261031`. ⚠ plist holds the API key in
  plaintext — migrate to keychain (`wigolo` stores provider keys under
  keychain service `wigolo-openai`, which **shadows** env vars: keychain → file → env).
- Benchmark harness + findings: `/tmp/bench/` (ephemeral) and
  `~/wigolo-alternatives-benchmark-2026-10-31.md` (durable).
