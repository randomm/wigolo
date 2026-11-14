# ADR-0002: Carry upstream fixes (PR #637 + binary-train force-probe) as fork commits

- Status: Accepted (pending owner sign-off on design doc)
- Date: 2026-11-14
- Deciders: Janni (owner), Hermes agent (designer)

## Context

Three fixes we need are not on upstream `main`: the degraded-pool junk gate + captcha-as-error live only in **open, unmerged PR #637** (head `328bc85b`, `mergeable:false`); the force-probe recovery wave (`68558c33`, 10 s spacing) + post-wave collapse verdict (`09b486ca`) exist only on the **`binary-v0.2.1-sd507.1`** tag lineage (ancestry verified 2026-11-14, diverged from main). Today's pool collapse proved the production consequence: recovery wave no-oped through open breakers and news-vertical bait shipped.

## Decision Options

1. **Carry**: cherry-pick the two binary-train commits; hand-adapt PR #637's hunks (`isCaptchaHtml` in `user-agents.ts`, `DEGRADED_LOW_LEXICAL=0.4`, `degraded_pool_low_lexical` signal in `hybrid/signals.ts`, captcha throws in ddg/mojeek) onto our branch. *(chosen)*
2. Wait for upstream to merge: #637 is open since 2026-09-26 with no merge train; the binary lineage appears unmaintained as a source. Leaves halo exposed in the interim — and halo is the only egress.
3. Ask upstream to merge then rebase: cleanest long-term but couples our timeline to a third party and requires the Mac rebase ritual now.

## Consequences

- Positive: immediate, testable; keeps FORK.md register honest (each carry listed as our divergence, same as the bing bait commit `93d74858`).
- Negative: divergence grows; when upstream eventually merges #637, our carry must be dropped during the Mac's rebase — flag in FORK.md register at cherry-pick time.
- Neutral: captcha throws classify as FailureClass `other` under the current classifier (`engine-base:202-209`) — acceptable; do not fork the class taxonomy.
