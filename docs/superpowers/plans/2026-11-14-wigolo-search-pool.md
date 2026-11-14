# Wigolo Search-Pool Health & Engine-Config Implementation Plan (v2)

> **For agentic workers:** Execute task-by-task — normally via the pi-rukas work driver; inline with executing-plans only if no driver exists. Steps use checkbox (`- [ ]`) tracking.
> **v2:** rewritten after five gate lanes (builder-check, QA, traceability, STRIDE/ops, diagram); their evidence: `/opt/data/cache/scratch/gate-*/`. The traceability + STRIDE lanes returned NO-GO on v1; every BLOCKER/MAJOR is closed below or listed under Owner decisions.

**Goal:** Make wigolo's search pool survive engine death honestly, give the operator config-driven engine on/off, and add Kagi as a paid precision engine — shipped through the fork candidate → gated-tag → owner-promote pipeline.

**Architecture:** Commits on topic branches of `randomm/wigolo`; two gated waves; pool logic in `src/search/core/`, engines in `src/search/engines/`, all knobs parsed in `src/config.ts` (env > config.json > default). Read the design doc first: `docs/superpowers/specs/2026-11-14-wigolo-search-pool-design.md` (REQ-1..10, QS-1a..18) + `docs/decisions/ADR-0001..0004`.

**Tech Stack:** TypeScript, Node **≥ 22** (`package.json engines`; prod runs v24), vitest — **tests live under `tests/**/*.test.ts` ONLY** (`vitest.config.ts` include; src-collocated tests never run), playwright pinned 1.60.0.

## Global Constraints

- Halo NEVER pushes fork `main`; push topic branches only (`https_proxy=http://wigolo-proxy:3128`, `git -c credential.helper='/usr/bin/gh auth git-credential'`). Owner hand-merges. **Docs commit first** (Task 0.0): the spec/plan/ADRs are committed before any execution so the audit trail is immutable; owner acks quote that commit SHA.
- Gated tags `vX.Y.Z-halo.N` via `wigolo-fork tag` (lint green + unit failures ⊆ base tag, cached per commit). Never move/reuse a tag. Host `~/wigolo-fork` refresh (`fetch + checkout -B main origin/main`) runs ONLY inside the approved tagging batch. **No Mac rebase during a promote window** (coordination note in the ask).
- Host-side work: ONE staged script per `hostctl run` approval under `/home/janni/outputs/wigolo/` (inline commands >4000 chars forbidden); name the request id in chat; **record the script's sha256 in the ask text — the script re-verifies its own digest before running** (TOCTOU). Lapsed asks never auto-resend: one chat line, zero executed commands, verified via `hostctl logs` count 0 in window. `hostctl logs/podman-ps` are free — use them, don't script them.
- Never restart hermes/llama-swap; never touch squid/hostctl policy.
- Throwaway smoke containers: distinct name prefix not matching prod, **no published ports** (`.HostConfig.PortBindings` empty), ≤25 `/v1/search` calls attributed (counted from squid lines), same runtime args minus secrets, random token, 0 Cloudflare-fronted requests, removed after (`podman ps -a` baseline).
- Secrets via podman `Secret=…,type=env,target=…` (the `WIGOLO_API_TOKEN` precedent), never literal `Environment=KEY=*** key value never enters git, the OPEN-LINK diff (name only), archived logs, or artifacts. The bearer-zero-hit grep runs as an **exiting gate step** (QS-14), plus first-8-chars-of-key probes — never an attached, self-attested note.
- Persisted artifacts store counts/verdicts/telemetry — NEVER result bodies/query text (the journal already logs query text; artifacts don't repeat it).
- `grep -a` mandatory in `src/search/core/` AND `src/cache/` (literal NUL bytes: `orchestrator.ts:~550`, `store.ts:1077` — tools silently skip these files otherwise, which would falsify the QS-6 disk audit).

## Review Focus (each line pinned to a named test/artifact)

1. Engine egress bypassing squid (#629) → Task 1.4 named evidence `runs/2026-11-XX-egress-audit.md` (fresh markers, allowlist, conntrack control); if bypass TRUE → Task 1.4b named test `tests/fetch/engine-egress-dispatcher.test.ts` (new; repo has a pinned-dispatcher test precedent).
2. Kagi Result persisted anywhere → Task 2.3 `tests/unit/search/cache-transient-results.test.ts` (new) + QS-6a **SQL** asserts (not grep) on the throwaway's `wigolo.db` (+ re-check after WAL checkpoint).
3. Silent bait-drop read as healthy → Task 1.2 `soft_block_dropped` caller-visible test (requires extending `buildEngineWarnings` — today it emits only for `outcome==='error'`).
4. Forced-probe storm at 100× → Task 1.1 spacing tests QS-1a(iii) **plus metered exclusion (brave+kagi get 0 forced probes — QS-5)**.
5. Disable-list footgun (typo / empty pool) → Task 2.1 QS-4 six cases incl. precedence + memoization + normalization.

## Traceability (REQ → design § → ADR → task → named test/artifact)

| REQ | § | ADR | Task | Test / artifact (status verified @ 09ae5b76) |
|---|---|---|---|---|
| REQ-1 force-probe recovery | §4/5/6 | ADR-0002 | 1.1 | `tests/unit/search/degraded-recovery.test.ts` **exists — add cases** (QS-1a); smoke dead-host fixture (QS-1b) |
| REQ-2 bait + visible drops | §4/5 | ADR-0002 | 1.2 | `tests/unit/search/engines/bing-news-bait.test.ts` (new), `bing-bait.test.ts` (exists, keep green via re-export), captcha cases in existing `duckduckgo.test.ts`/`mojeek.test.ts`, core-provider `soft_block_dropped` case (QS-2a–e) |
| REQ-3 429 escalation | §4/5 | — (tuning; design-backed, no ADR — owner accepts via D7) | 1.3 | `tests/unit/search/engine-breaker.test.ts` add cases (QS-3) |
| REQ-4 disable surface + policy digest | §4/5/8 | ADR-0001 | 2.1, 2.4 | `tests/unit/search/engine-disable.test.ts` (new) (QS-4); `engine_policy` digest/weekly line incl. kagi spend |
| REQ-5 kagi join iff key | §4/5 | ADR-0001, 0003 | 2.2 | `tests/unit/search/engines/kagi.test.ts` (new) roster cases both verticals |
| REQ-6 transient/ToS/spend | §5/8 | ADR-0003 | 2.2, 2.3 | `kagi.test.ts` (401-circuit, no-extract, budget QS-6e) + `cache-transient-results.test.ts` (new) (QS-6a/b) |
| REQ-7 gated pipeline | §2/7/8 | ADR-0004 | 0.0, 1.5, 2.4 | ancestor-assert output, QS-7a candidate identity, QS-7b six-value record, QS-7d rollback **rehearsal** record |
| REQ-8 brave joins | §3/7 | ADR-0004 (wave-0 hardening) | 0.1 | journal + telemetry `result_count>0` over ≥3 marker queries + run note (zero-code; evidence artifact) |
| REQ-9 proxy audit | §2 | — (audit; no ADR — owner accepts via D7) | 1.4 (+1.4b cond.) | named squid evidence + conntrack control (QS-11); cond. `engine-egress-dispatcher.test.ts` |
| REQ-10 metered parity | §5/8 | ADR-0003 | 1.1, 2.2 | QS-5 forced-probe-exclusion assertions (kagi **and brave**, 0 calls in recovery wave) + budget cases |

## Repo baseline (re-verified @ 09ae5b76 on 2026-11-14; lanes corrected v1's drift)

`randomm/wigolo@v0.3.1-halo.3` @ `09ae5b76` == `main`.
Anchors: `bing.ts:71-76` `looksLikeBaitSerp`, `:130-149` UA rotation; `bing-news.ts` 135 lines upstream-identical, `:84` single UA, `:103` `li.b_algo` fallback; `engine-base.ts:145-183` constants (`TRANSIENT_COOLDOWN_MS=5000`, `RATE_LIMIT_MAX_COOLDOWN_MS=30_000`, ladder cap `MAX_COOLDOWN_MS=180_000`, `CHRONIC_TRIP_THRESHOLD=3`), `:197` `FailureClass='rate-limit'|'forbidden'|'other'`, `:202-209` classifier, `:227` name-keyed breakers, `:287-294` flat-5 s rate-limit branch (never touches `trips`), `:296-299` ladder, `:486-493` every throw feeds `recordFailure`; `orchestrator.ts` recovery wave `:687-745` (log line `:732`) — **v1's `:712-715,727-743` and `:429-432` "re-skip" citations were anchor drift; re-derive exact lines at implementation, do not trust either set**; `src/search/core/core-provider.ts:500-540` telemetry, `:652-692` junk gate (exemption-withdrawal only), `:776` `cacheSearchResults` (`enginesUsed` already a parameter — single core-path writer), `:814-827` engine_pool; `buildEngineWarnings` (emits only `outcome==='error'`); `score-floor.ts:24,107-126,170-177`; `hybrid/signals.ts`; `verticals/general.ts:25-28` memoization, `:27-59` roster, `:53-55` brave key-gate, `_resetGeneralEnginesForTest` `:61`; `news.ts:37-77`, `_resetNewsEnginesForTest` `:79`; `config.ts` 835 lines: **`resetConfig()` at `:830`** (v1's 601-604 was `getConfig` memoization), `:639` envBool, `:673` braveApiKey, `:648` `CACHE_TTL_SEARCH=86400` (**24 h** — v1's "20-min" was wrong), `:619` searxngUrl, `:731` searchBackend; `src/cache/store.ts` SQLite-only (`search_cache` `:415/:442`; **no memory result tier exists**); `src/search/legacy/searxng-orchestrator.ts:333,558` (unreachable under `WIGOLO_SEARCH=core`); `types.ts:937` `RawSearchResult` (`title`,`url`,`snippet` all required); `src/daemon/http-server.ts:208` unauth `GET /health`, `:304-327` admin-token+host-allowlist gates; squid CONNECT-only (no ssl_bump).
Tests that EXIST (v1 fabricated some paths — verified via `find tests`): `tests/unit/search/degraded-recovery.test.ts` (imports `engine-base.js`), `tests/unit/search/engine-breaker.test.ts` (imports `wrapWithRetryAndBreaker`), `tests/unit/search/engines/bing-bait.test.ts` (imports `looksLikeBaitSerp` from `bing.js`), `tests/unit/search/engines/duckduckgo.test.ts`, `mojeek.test.ts`, `core/core-provider-*.test.ts`; **no** `cache.test` exists (2.3 names a new file). `src/search/engines/user-agents.ts` (**not** `util/`).
Fix sources: tag `binary-v0.2.1-sd507.1` ⊃ `68558c33`,`09b486ca` (absent from main; fetched in Task 1.1 Step 2); PR #637 head `328bc85b`, `mergeable:false` — carries `isCaptchaHtml` (user-agents), `DEGRADED_LOW_LEXICAL=0.4`, `degraded_pool_low_lexical` (`hybrid/signals.ts`), captcha throws in ddg/mojeek. Kagi: `POST …/api/v1/search` Bearer; host pinned as **D6 owner confirm** (`kagi.com` vs `api.kagi.com`); never `/extract`; $12/1k ⇒ **`$0.012/query` is the ONE constant** (design + plan + test assert the same).

## Task 0.0: Commit the docs (audit trail)

- [ ] On the halo clone `/home/janni/projects/wigolo-fork` @ `origin/main`: `git checkout -B docs/search-pool-2026-11`, add `docs/superpowers/` + `docs/decisions/`, commit `docs(search): search-pool design, plan, ADRs` with `Janni Turunen <janni@turunen.in>`, push the branch (never main). Record SHA in every later run note.

## Wave 0 — Pool relief, zero code (owner-gated env)

### Task 0.1: Brave joins the general pool

**Files:** Modify (owner hand-merge, quadlet — **name the exact live path** `~/.config/containers/systemd/hermes/*.container` and keep the `server-docs/.../quadlet/` git copy in sync): `Secret=`/`EnvironmentFile=`-style addition for `BRAVE_API_KEY` (name-only in the diff; value in the host env file; assert post-merge `git grep -I 'BRAVE_API_KEY='` returns only the name form).

- [ ] **Step 0:** Boot-mode assert: logs/inspect show the daemon started with the api-token secret present (missing token secret ⇒ daemon falls back to Host-allowlist mode on wigolo-net — fail loudly, don't proceed).
- [ ] **Step 1: Rehearse the env-change path BOTH legs** (ADR-0004, QS-9): one benign quadlet edit → `podman-system-generator --dryrun` → env-file existence+parse assert → `systemctl --user restart wigolo` → unit active + `GET http://wigolo:3333/health` 200 (unauth, `http-server.ts:208`) + `.Created` changed + labels unchanged → **restore `.bak` → restart → re-assert the RESTORE leg too** + `diff` live quadlet vs the `server-docs` git copy (both copies) + a **functional probe beyond /health**: one search + one fetch-answer query like `prod_watch` does (a `/health`-only check hid the 2026-11-09 LLM-key class regression). Record `.bak` path + all four `.Created` values.
- [ ] **Step 2: Apply Brave env** via the same dryrun→restart→assert→functional-probe sequence; single staged script (sha256 in ask); pre-staged+pre-approved rollback script exists **before** the edit.
- [ ] **Step 3: Verify join:** 3 fresh marker queries (`POST /v1/search`, Bearer from `/opt/data/.env`, never echoed); `hostctl logs wigolo.service 4000` shows brave in dispatch; `engine_telemetry` brave `result_count > 0` ≥3/3. Brave 403/429 ×3 ⇒ declare-rollback (QS-9: healthy ≤10 min).
- [ ] **Step 4:** Run note `/home/janni/outputs/wigolo/runs/2026-11-XX-brave-env.md` (counts only; QS-14 exiting secret-gate step, not an attached grep).

## Wave 1 — Pool resilience (branch `pool-health-2026-11`, one tag, one promote)

### Task 1.0: Dev checkout + baseline

- [ ] **Step 1:** Clone/`origin/main` @ `/home/janni/projects/wigolo-fork`; add upstream remote; `git fetch --tags upstream` (proxy per Global Constraints).
- [ ] **Step 2:** Baseline: read `package.json` scripts, mirror the gate command exactly (`npm ci && npm run lint && npm run test:unit`); record command AND failure set to `/home/janni/outputs/wigolo/runs/baseline-tests.md` (the ⊆-gate compares against this). Full `npm test` includes e2e — not the gate criterion.
- [ ] **Step 3:** `git checkout -B pool-health-2026-11 origin/main`.

### Task 1.1: Force-probe recovery wave + metered exclusion

**Files:** Modify `src/search/core/orchestrator.ts` (recovery wave `:687-745`; NUL at ~`:550`), `src/search/core/engine-base.ts`. Test: `tests/unit/search/degraded-recovery.test.ts` (**exists — add cases**; fake timers + `_resetBreakersForTest()` + `resetConfig()`, engines injected as fakes).

**Interfaces:** Recovery wave dispatches every skipped primary **plus** the held-out probe-only engine; licensed on the collapse branch only; `FORCED_PROBE_MIN_SPACING_MS = 10_000` per engine (do not invent a per-query cap); collapse verdict re-derived **after** the wave; probe wave runs with a reduced per-probe soft deadline (≤3 s) so QS-1c stays arithmetically reachable (unbounded awaited 10 s probes ⇒ ~22 s collapse path); **new engine static flag `metered`** — metered engines (brave from this wave, kagi later) are excluded from the forced-probe roster entirely.

- [ ] **Step 1: Failing tests (QS-1a):** (i) 3 primaries open + probeOnly engine ⇒ ≥1 unwrapped `engine.search` call per skipped primary + ≥1 for the probeOnly engine in the same dispatch (today's wrapper re-skip makes 0 — this is the falsifiable delta); (ii) 0 external calls for non-skipped engines; (iii) fake clock 60 s × 10 repeat queries vs always-failing engines: ≤6 probes/engine/min AND ≥10 000 ms between consecutive probes of one engine; (iv) probe with ≥1 result ⇒ `pool_degraded.reasons` excludes `pool_collapsed`, all fail ⇒ includes it; (v) wave once per dispatch. Plus: brave excluded from forced probes (0 calls) — REQ-10.
- [ ] **Step 2:** `git fetch upstream tag binary-v0.2.1-sd507.1` → `git cherry-pick 68558c33 09b486ca`; resolve against the diverged fork orchestrator by hand; keep the fork's thin_pool gate intact.
- [ ] **Step 3:** Unit tests PASS (incl. pre-existing recovery tests). **Update FORK.md divergence register** in the same commit (ADR-0002): source tag + the two SHAs + one-line scope. Commit `fix(search): force-probe breaker-open engines in recovery wave (from binary-v0.2.1-sd507.1)`.

### Task 1.2: Bait gating for news + visible soft-blocks + PR #637 carry

**Files:** Create `src/search/engines/bing-bait.ts` (owns+exports `looksLikeBaitSerp` moved from `bing.ts:71-76`; **`bing.ts` re-exports it** so `tests/unit/search/engines/bing-bait.test.ts`'s import from `bing.js` stays green). Modify `src/search/engines/bing-news.ts` (gate + `nextUserAgent()` rotation mirroring `bing.ts:130-149`; `li.b_algo` fallback `:103` only when news cards exist), `src/search/engines/duckduckgo.ts` + `mojeek.ts` (captcha-as-error), `src/search/engines/user-agents.ts` (**`engines/`, not `util/`**; new `isCaptchaHtml`), `src/search/core/core-provider.ts` (degraded drop at the `:652-692` gate; **extend `buildEngineWarnings` to emit `soft_block_dropped` for `outcome==='ok'` with `result_count:0`** — journal lines do NOT satisfy QS-2d), `src/search/hybrid/signals.ts` (`degraded_pool_low_lexical`). Tests: new `tests/unit/search/engines/bing-news-bait.test.ts`; cases in existing `duckduckgo.test.ts`, `mojeek.test.ts`, `core/core-provider-*.test.ts`.

**Interfaces:** `looksLikeBaitSerp(query, results)` unchanged semantics; captcha ⇒ thrown `Error('… captcha challenge')`, `classifyFailure==='other'` (three FailureClass values only — do NOT assert `forbidden`/`blocked`); degraded drop: `poolIsDegraded && lexicalAlignment < 0.4 ⇒ drop`, boundary stated inclusive/exclusive; fixtures **must set `evidence_score.components.lexical_alignment` explicitly** (accessor defaults 0 ⇒ the (0,0.4) band is unrepresentable otherwise); QS-2e: docs/images/code/papers rosters deep-equal baseline.

- [ ] **Step 1: Failing tests (QS-2a–e):** (a) 6 bait fixtures (real `lexicalAlignment()`, mean <0.05, ≥3 results; 3 bing + 3 bing_news) ⇒ `[]`, fetch exactly 2× with differing UA; **plus 2 genuine controls ⇒ unchanged + 0 `soft_block_dropped`**; (b) news page with only `li.b_algo`, no cards ⇒ `[]`; (c) captcha fixtures ⇒ thrown, breaker +1, class `other`; (d) degraded pool, lex 0.39 dropped / 0.41 kept / 0.40 boundary asserted, signal present; (e) warning visible: `engine_warnings[].code==='soft_block_dropped'` + telemetry `result_count:0`; (f) existing bing-bait tests green via re-export; (g) other-verticals roster sweep.
- [ ] **Step 2:** Implement (move gate; carry #637 hunks per baseline notes).
- [ ] **Step 3:** Unit tests PASS. **FORK.md register**: PR #637 entry (head `328bc85b`, files carried, `mergeable:false` note). Commit `fix(search): bait-gate bing_news, captcha-as-error, degraded-pool junk drop (carries PR #637)`.

### Task 1.3: Sustained-429 escalation

**Files:** Modify `src/search/core/engine-base.ts` rate-limit branch (`:287-294`) ONLY; test `tests/unit/search/engine-breaker.test.ts` add.

**Interfaces:** consecutive-throttle counter per engine; `SUSTAINED_RATE_LIMIT_N = 5` ⇒ subsequent reopens take the hard-fail ladder (`min(60s·2^n, 180s)`) AND feed `trips`/`sessionTrips`; any success between resets counter; non-sustained path keeps flat `5000` AND the existing `RATE_LIMIT_MAX_COOLDOWN_MS=30_000` cap (don't smuggle the ladder's 180 s through the front door); `MARGINALIA_MIN_INTERVAL_MS=2000` untouched.

- [ ] **Step 1: Failing tests (QS-3):** throttles 1–5 ⇒ `cooldownMs===5000`, trips 0; 6th ⇒ ≥60 000 + `trips≥1` + `sessionTrips≥1`; **3 escalation events ⇒ `isEngineChronicallyUnhealthy()===true`** (chronic means `sessionTrips≥3`; `trips≥1` alone proves nothing); 12 consecutive ⇒ no cooldown >180 000, class stays `'rate-limit'`; interleaved 429/success ×6 ⇒ all 5000, trips 0, sessionTrips 0.
- [ ] **Step 2: Implement. Step 3: PASS.** Commit `fix(search): escalate sustained rate-limiting to chronic breaker class`.

### Task 1.4: Proxy-bypass audit (upstream #629)

- [ ] **Step 1:** Throwaway container (containment per Global Constraints + QS-15): **fresh-marker queries** (`CACHE_TTL_SEARCH` is 24 h — a cache hit would fake "bypass confirmed") forcing each engine family (general+news); capture wigolo-proxy squid log for the window.
- [ ] **Step 2:** Expected-host **allowlist** (10 engines + kagi host when keyed): each must appear as `TCP_TUNNEL/200` ≥1 line per host per query; any host delivering results with no squid line ⇒ bypass TRUE. Negative control: 0 engine-IP connections in the wigolo netns whose next hop isn't `wigolo-proxy:3128` (conntrack or `/proc/net/tcp` — name the instrument in the note). Flag unreviewed hosts (observed: `incoming.telemetry.mozilla.org` ×47 — record disposition). Evidence (`grep -a` squid + dispatch lines, counts only) → `runs/2026-11-XX-egress-audit.md`. Until this passes, QS-1/2/3 telemetry is reported **untrusted**.
- [ ] **Step 3:** If bypass TRUE: Task 1.4b — route engine fetches through the proxy-aware dispatcher (undici `EnvHttpProxyAgent`/global agent as the repo's fetch layer supports; mirror how `bing.ts` gets proxied), own commit, **named test `tests/fetch/engine-egress-dispatcher.test.ts`** (new; follow the repo's pinned-dispatcher test precedent), re-run Step 1 to prove closure. Owner (D5) decides upstream filing.

### Task 1.5: Wave-1 promote (hardened per ADR-0004)

- [ ] **Step 1:** Push `pool-health-2026-11`; give owner the merge link (OPEN-LINK). **BLOCKING: nothing further runs until owner confirms merge.**
- [ ] **Step 2 (one approved batch):** host clone `git fetch -q origin && git checkout -q -B main origin/main` → `git merge-base --is-ancestor <wave-tip-sha> origin/main || exit 1` (abort = false-promote gate; abort **before** `wigolo-fork tag`, assert 0 new tags after, "aborted: not ancestor" in run note) → `wigolo-fork status` trunk check (record `fork_main_ahead/behind`) → `wigolo-fork tag main --base v0.3.1` → `wigolo-maint candidate`. **Candidate identity assert (QS-7a): `candidates/<tag>.json` `status==='pass'` AND `fork_commit` == wave tip read from `git ls-remote --tags origin` (peeled)** — `already-tested`/mismatch ⇒ promote refused with reason (defends the `fork_build()` highest-tag reuse hazard). Record wave-tip SHA + tag + candidate `image_id`.
- [ ] **Step 3: Smoke** the candidate in a throwaway (QS-15 containment): **dead-host fixture (extra_hosts override) forces breakers open** — the falsifiable REQ-1 test v1 lacked: force-probe journal lines, ≥1 external probe per forced-open engine AND **0 forced brave probes** (metered exclusion). Then fresh-marker 10 general + 5 news: ≥8/10 `resultCount>0` **or honest-empty with degraded reasons** (QS-17); 0 bait offenses (titles-vs-query eyeball + zero-overlap rule); telemetry sane. Artifacts counts+verdicts only; QS-14 exiting gate.
- [ ] **Step 4: Rollback rehearsal BEFORE promote** (QS-7d): run pre-staged `wigolo-maint rollback` once → exits 0, container recreated, `/health` 200 ≤120 s; **toggle guard**: record promoted image id — a second rollback without an intervening promote refuses non-zero (v1's swap semantics re-promoted the bad build on double-run); missing `previous_tag` ⇒ refuse (never restart an unnamed image); confirm the rollback image survives the day-7 cleanup for the watch window. Then owner-initiated promote (`hostctl run`, timeout ~1500, auto-rollback on `prod_watch` triggers — QS-7c defines "misbehaves": http≠200 functional / `NRestarts`↑ / node_crash, 600 s @30 s).
- [ ] **Step 5: Identity check before any "live" wording** (QS-7b): `.Created` > promote start; `.Image` id == candidate `image_id`; label `wigolo.commit` == wave tip and ≠ `"unknown"`; `/health` 200 healthy; live `/v1/search` `resultCount>0` — all six in the run note; **checker negative test once**: point it at a deliberately wrong SHA ⇒ it must fail (QS-12). Owner ack quotes the six values + the Task 0.0 docs SHA.

## Wave 2 — Engine config + Kagi (branch `engine-config-2026-11`, **cut only after the wave-1 tag exists**; QS-13 ancestor gate before first push)

### Task 2.1: `WIGOLO_DISABLE_ENGINES`

**Files:** Modify `src/config.ts` (new key beside the `:673` braveApiKey pattern; env + config.json `settings.disabledEngines`, comma-separated, precedence env > config.json > default), `src/search/core/verticals/general.ts`, `news.ts` (filter at construction, BEFORE the `:25-28` memoization). Test: `tests/unit/search/engine-disable.test.ts` (new; every env flip preceded by `resetConfig()` (**`config.ts:830`**, not 601-604) + `_resetGeneralEnginesForTest()` + `_resetNewsEnginesForTest()`).

**Interfaces:** `config.searchDisabledEngines: Set<string>`; unknown name ⇒ exactly one warn listing all valid names, roster UNchanged (a typo never silently drops a valid sibling); disable-all ⇒ error + **UNfiltered** roster (never zero-engine); unset ⇒ deep-equals committed golden serialization (names+weights+secondary+probeOnly+quality, both verticals).

- [ ] **Step 1: Failing tests = QS-4's six cases:** (1) unset ⇒ golden; (2) `bingg` ⇒ one warn, unchanged; (3) disable-all ⇒ error, full roster, ≥1 engine per vertical; (4) `marginalia,mojeek` ⇒ exactly those absent from general AND news, all others byte-equal; (5) precedence: config.json alone, then env overriding config.json; (6) normalization `' Bing ,, ddg '` + memoization-trap documentation (stale roster without resets, correct with).
- [ ] **Step 2: Implement. Step 3: PASS.** Commit `feat(search): operator-controlled engine disable list`.

### Task 2.2: Kagi engine

**Files:** Create `src/search/engines/kagi.ts`; Modify `src/config.ts` (`kagiApiKey` ← `WIGOLO_KAGI_API_KEY`, `kagiDailyBudgetUsd` ← `WIGOLO_KAGI_DAILY_BUDGET_USD` default `1.0`), `verticals/general.ts` + `news.ts` (key-gated join both rosters, brave `:53-55` pattern, primary wave, weight 1.0, quality 'high'). Test: `tests/unit/search/engines/kagi.test.ts` (new — under `tests/` or vitest never runs it; no live network; mock fetch).

**Interfaces:** `KagiEngine` name `"kagi"`, `static metered = true`, `static transientResultsOnly = true`. `search()`: `POST https://<D6-host>/api/v1/search`, Bearer, body `{query, limit: maxResults ?? 10}` (base path only; unit mocks assert the exact path — prod squid is CONNECT-only, hosts only); map `data.search[]` → `RawSearchResult[]` (`title`,`url`,`snippet` required per `types.ts:937` — synthesize `snippet:''`); 10 s timeout. **401 caught INSIDE the engine** (counter; ≥3 consecutive ⇒ park 15 min: `[]` <50 ms + 1 warn; nothing thrown ⇒ `recordFailure` never sees it, breaker rows stay clean); 429/403 ⇒ throw (classifier maps). **Budget:** cost constant `$0.012/query`; ledger = **module-level, shared across both roster instances, persisted outside process memory** (SQLite table or JSON file outside the artifact dir — an in-process counter is 2× understated × restart-multiplied); **pre-increment predicate `spent + cost <= budget`**; UTC-day reset; `BUDGET=0` ⇒ 0 fetch; warn once per cap event (not per call).

- [ ] **Step 1: Failing tests:** roster key/no-key both verticals; fixture mapping + required-field drops; 429 ⇒ classified rate-limit; QS-5 boundaries (2×401 dispatch, 3rd parks, park+14:59 ⇒ `[]` / +15:00 ⇒ exactly 1 fetch, success between 401s resets, hanging fetch settles ≤10.1 s WITHOUT parking, breaker purity `getEngineSessionTrips('kagi')===0` + no snapshot row); **QS-5 recovery-wave exclusion: 0 kagi calls inside the QS-1a wave (and the brave twin)**; QS-6c every mock URL path === `/api/v1/search`, 0 `/extract`, 0 other hosts; QS-6e budget: queries 1..83 dispatch (83×0.012=0.996), 84th refused 0 fetch 1 warn, `BUDGET=0` 0 fetch, fake clock 00:00Z UTC reset, free engines unaffected, ledger survives fresh module re-init (restart proxy).
- [ ] **Step 2: Implement. Step 3: PASS.** Commit `feat(search): Kagi v1 API engine (key-gated, ToS-transient, spend-guarded)`.

### Task 2.3: ToS — real transient tier + persistence guard

**Files:** Create the **memory tier** (none exists — SQLite `search_cache` only, 24 h TTL): small in-memory TTL≤60 s result cache for `transientResultsOnly` engines, wired into the query path (name the exact module at implementation; propose `src/cache/transient-results.ts`). Modify `src/search/core/core-provider.ts` at `cacheSearchResults` (`:776`): skip persistent write when any contributor is `transientResultsOnly` (single choke point; legacy writers `legacy/searxng-orchestrator.ts:333,558` unreachable under core — comment, don't touch). Test: **`tests/unit/search/cache-transient-results.test.ts` (new — v1's bare "cache.test" existed nowhere)**.

- [ ] **Step 1: Failing tests (QS-6):** same query at t, t+59 s (0 fetch), t+61 s (1 fetch), fresh process (1 fetch) — a 20-min TTL FAILS this; persistent-write skip: kagi-contributing query writes zero `search_cache` rows — assert via **SQL on the real store** (`SELECT count(*) FROM search_cache WHERE engines_used LIKE '%"kagi"%'` = 0, same by `query_hash`, re-asserted after WAL checkpoint; grep is not a valid instrument — and if any grep remains, `grep -a` because of `store.ts` NUL); mixed kagi+free query ⇒ total rows for that `query_hash` == 0 (record the accepted side effect: **24 h** cache hit-rate loss for all contributors of mixed queries — v1's "20-min" was 72× understated).
- [ ] **Step 2:** Implement tier + guard. **Step 3: PASS.** Commit `fix(cache): transient ≤60s tier; Kagi results exempt from persistent cache (API ToS)`.
- [ ] **Step 4:** QS-6d artifact hygiene: 20-char fixture probes + bearer greps as the QS-14 exiting step.

### Task 2.4: Wave-2 promote + REQ-4 policy surfacing

Mirror Task 1.5 (push → owner merge → ancestor assert → **QS-13 wave-1/wave-2 ancestry** → tag → candidate identity assert QS-7a → smoke → rollback rehearsal → owner promote → identity check QS-7b/12) plus:
- Smoke adds: `WIGOLO_DISABLE_ENGINES=marginalia` excludes it from both rosters; with owner-issued test key (D2; if open: promote keyless, kagi smoke `NOT RUN`): kagi answers; squid shows the pinned kagi **host** CONNECT (path unit-asserted only — CONNECT-only squid, no ssl_bump).
- **Kagi kill-switch pre-staged:** `WIGOLO_DISABLE_ENGINES=kagi` env script, pre-approved alongside this wave.
- **`engine_policy` line** in health digest + weekly report (REQ-4 — the only home this line needs): effective disabled list, active optional engines, **kagi spend read from the persistent ledger** (no data source ⇒ no DoD claim). Keep `wigolo_weekly.py` container/host copies identical; same approved batch.

## Wave 3 — Acceptance & watch

### Task 3.1: Acceptance battery

- [ ] Script `/opt/data/outputs/wigolo/wigolo-acceptance.sh`: 10 general + 5 news fresh-marker queries; ≥8/10 `resultCount>0` **OR honest-empty shape** (QS-17 — the unconditional `engine_pool.healthy ≥ 1` is REMOVED: it failed exactly when honesty held); 0 top-5 zero-token-overlap; p95 < 8 s **at the pinned n** (battery JSON, end-to-end `/v1/search` wall time — method recorded); output counts+verdicts only; QS-14 exiting gate; exit 1 on breach.
- [ ] Run against promoted prod; archive beside the promote record.

### Task 3.2: 7-day watch

- [ ] Daily from `/home/janni/outputs/wigolo/health/<date>.json`: **freshness assert first** — file mtime < 26 h (a dead `wigolo-maint.timer` was green for days in v1's design); `journal.status_137`, `unit.NRestarts` (trust journal for OOM, not `oom_killed_last`), breaker churn via `hostctl logs`. Compare vs 2026-11-13 baseline (pool-degraded ~37/4h).
- [ ] Origin story (QS-18): songbook "Queen Who Wants to Live Forever chords lyrics" ×3 consecutive runs, same verdict; ≥3 of top-5 from chord-capable domains, ≥2 shared tokens; 0 top-5 zero-overlap; harness grep contains 0 `curl` escape hatches. Report deltas + kagi spend **from the ledger** to owner.

## Definition of done

All checkboxes; Task 0.0 docs-commit SHA quoted in every run note; both promotes carry QS-7a candidate-identity + QS-7b six-value records and a **rehearsed** (not just staged) rollback; battery passed incl. honest-empty variant at pinned n; 7-day watch with freshness assert; kagi (if enabled) within `WIGOLO_KAGI_DAILY_BUDGET_USD` per the **persistent ledger** with zero persisted Results (QS-6a SQL asserts); REQ-9 audit passed or its TRUE-branch fix merged; traceability table fully green.

## Owner decisions

D1 Brave key + quadlet env (Task 0.1) · D2 Kagi account+key (gates 2.4 smoke; keyless promote allowed, kagi `NOT RUN`) · D3 budget default $1.0/day (pre-increment, shared persistent ledger) · D4 promote approvals, never auto · D5 upstream filings after 1.4 · **D6 confirm Kagi API host (`kagi.com` vs `api.kagi.com`) from live docs before 2.2 ships** · **D7 accept REQ-3/REQ-9 shipping design-backed without separate ADRs (traceability lane m7), or we write ADR-0005/0006 first**.
