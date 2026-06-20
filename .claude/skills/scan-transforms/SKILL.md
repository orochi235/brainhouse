---
name: scan-transforms
description: Use when checking whether our selector schema still matches real Claude Code logs, refreshing observed.json version metadata, or hunting for new event patterns worth a transform. Runs the deterministic scan and summarizes; only reasons about new candidates when asked.
---

# scan-transforms

Keep the selector schema (`client/src/transforms/selectors/registry.ts`) honest
against real Claude Code logs.

## Run the scan

From the repo root:

    npm run scan:transforms          # last 14 days
    npm run scan:transforms -- --all # full history
    npm run scan:transforms -- --since 30

This rewrites `client/src/transforms/selectors/observed.json` (committed) and
`scripts/.scan-out/unmatched-candidates.json` (transient, gitignored).

## Report (always)

After the run, summarize from the script's stdout + `observed.json`:

1. **Live selectors** — how many of N matched this window.
2. **Stale candidates** — selectors with `lastWindowCount: 0`, or whose
   `lastSeenVersion` lags the max Claude version in the logs. A selector that
   stops advancing across CC version bumps has probably had its trigger marker
   changed — flag it for a look at the corresponding transform.
3. **Top unmatched clusters** — the largest buckets from the candidates file,
   with their draft selectors.

Then stop. Do not auto-propose or write transforms.

## On request only

If the user asks "are any of these worth a transform?", read
`scripts/.scan-out/unmatched-candidates.json`, inspect the sample events, and
reason about which clusters represent a real recurring shape worth a selector +
transform. Reference `docs/transforms-schema.md` and the existing
`builtIn/*.ts` for the pattern.
