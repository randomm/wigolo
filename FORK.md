# FORK.md — local changes vs upstream

Our fork: `randomm/wigolo` · upstream: `KnockOutEZ/wigolo` · license: AGPL-3.0 (+ commercial dual).

**Branch model (decided 2026-10-31)**

- `main` — our build: upstream + our commits on top. Everything we run and
  install comes from here.
- Upstream sync ritual:
  ```bash
  git fetch upstream
  git rebase upstream/main          # replays our commits onto latest upstream
  npx vitest run tests/unit/search/engines tests/unit/search/core tests/unit/embedding tests/unit/fetch
  npm run build && npm install -g .
  launchctl kickstart -k gui/$(id -u)/com.trailopeners.wigolo
  git push --force-with-lease origin main
  ```
  Rebase rewrites our commit SHAs — expected on a personal fork. If a rebase
  breaks, the pre-sync state is one `git rebase --abort` away; tag before
  syncing when unsure: `git tag pre-sync-$(date +%F)`.
- `fix/*` — scratch branches while a fix is in flight; land on `main`, delete.

**Contribution posture:** upstream `CONTRIBUTING.md` auto-applies a CLA granting
the maintainer an irrevocable right to relicense any PR contribution for their
commercial offering. Default = keep fixes here, file upstream *issues* with
repros only. PRs require an explicit human decision each time.

## Divergences (all on `main`)

### ORT resource + egress-proxy hardening (from `halo/v0.3.1`, cherry-picked 2026-10-31)

| File area | Change | Why | Merge-conflict risk |
|---|---|---|---|
| `src/util/onnx-threads.ts` + `src/config.ts` | `WIGOLO_ONNX_THREADS` caps ORT intra-op pool (embedder + reranker) | ORT sizes pool from host CPUs, ignores container CFS quota: 32-thread host + `--cpus=4` → embedding 37s vs 3.7s, rerank 99s vs 11s, event-loop starvation → fetch timeouts | low |
| `src/embedding/fastembed-provider.ts` | fastembed batch cap; threads applied before model load | ORT memory arena stays bounded | medium — upstream touches idle-unload/generation logic here (conflict resolved once already) |
| `src/search/reranker/transformers-rerank-provider.ts` | score in batches | bounded ORT arena | low |
| `src/fetch/*` (3 commits) | opt-in egress proxy: resolved-IP SSRF enforcement delegated to proxy; TLS tier + PDF probe routed via it; daemon Playwright launched through it; direct browser egress refused | safe egress for self-hosted agents | medium — fetch is an active upstream area |

`halo/v0.2.1` was checked: its commits are earlier twins of the above
(the `amend!` commit only deleted pre-v0.3.1 code we never had) and the #630
pre-aborted-signal guard is already upstream. Nothing lost from that branch.

### bing bait-SERP guard + thin_pool gate (commit `93d74858`)

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
