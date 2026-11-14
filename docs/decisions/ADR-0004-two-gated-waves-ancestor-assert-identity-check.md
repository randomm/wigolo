# ADR-0004: Two gated release waves with ancestor-assert, identity check, pre-staged rollback

- Status: Accepted (pending owner sign-off on design doc)
- Date: 2026-11-14
- Deciders: Janni (owner), Hermes agent (designer)

## Context

wigolo is halo's single point of failure for all agent web traffic; the hostctl approval channel has lapsed before; promote has auto-rollback but the **env/quadlet path does not**; and a false promote (tag cut before the owner's merge landed, or a Mac rebase orphaning reviewed SHAs) would leave `state.json` claiming success on unshipped code. Wave-1 and wave-2 both touch the same roster files.

## Decision Options

1. **Two waves, hardened flow (chosen)** — per wave:
   owner GitHub-merge of the topic branch → **same approved batch** runs `git merge-base --is-ancestor <wave-tip> origin/main` (abort if false, **before** `wigolo-fork tag`, QS-13) + `wigolo-fork status` trunk check + host-clone refresh → gated tag → `wigolo-maint candidate` → **candidate-identity assert (QS-7a): `status==='pass'` AND candidate `fork_commit` == wave tip from `git ls-remote --tags origin` (peeled)** — hardening required because `fork_build()` builds from the highest remote `-halo.N` tag and a repeated key returns `already-tested`, so a wave-1 image can otherwise satisfy wave-2's promote → throwaway-container smoke (random name, no published ports, ≤25-query budget, **dead-host fixture forces breakers open so the force-probe fix is actually exercised**, QS-1b) → **owner-initiated promote** → post-promote identity check before any "live" wording (QS-7b six values: `.Created` fresh, `.Image` id == candidate `image_id`, label `wigolo.commit` == wave tip ≠ `"unknown"`, `/health` healthy, live query answers; plus one **negative test of the checker itself**, QS-12; never trust `is-active` alone) → owner ack recorded in run notes quoting the values + the docs-commit SHA.
   Wave 0 (quadlet env) additionally: `podman-system-generator --dryrun` pre-check + env-file existence/parse assert + a **rehearsed edit→restart→restore cycle with `.bak`, both legs asserted** (v1 asserted only the edit leg), **functional search+fetch probe** (not `/health` alone), and a diff of both quadlet copies against the `server-docs` git copy (QS-9). Wave-2 branch cut/rebased only after wave-1 tag exists. Rollback **rehearsed once before promote, not just pre-staged** (QS-7d), with a **toggle guard** (`cmd_rollback` swaps current/previous — a double run would re-promote the bad build; second invocation without an intervening promote must refuse), `previous_tag`-missing ⇒ refuse non-zero, rollback image retained beyond the day-7 cleanup for the watch window. Kagi kill-switch (`WIGOLO_DISABLE_ENGINES=kagi` env script) pre-staged with wave 2.
   Staged-script **TOCTOU hardening**: the dir under which scripts are staged is agent-writable, so every approved script's **sha256 is recorded in the ask text and re-verified by the script itself** before it does anything.
   "No fork rebase during the promote window" is a stated coordination rule with the Mac session.
2. Single big-bang release: fewer approvals, worst-case blast radius = pool + config + paid engine simultaneously — rejected.
3. Let promote's auto-rollback be the only safety net: it catches dead-on-arrival, not silent misbehavior or identity lies (restart that never recreated the container) — insufficient alone.

## Consequences

- Positive: every step falsifiable by evidence (ancestor check output, candidate JSON, identity check); owner sees exactly two asks per wave; rollback needs no live authoring during an incident.
- Negative: slower — two promote cycles; the rehearsal step adds ~30 min to wave 0.
- Neutral: keyless promotion allowed if the Kagi decision (D2) is still open — wave 2 ships with kagi dormant, kagi smoke explicitly marked `NOT RUN`; kagi enablement is then a config-only follow-up.
