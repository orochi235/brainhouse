# Out-of-band server-side auto-titler

## Problem

The current `auto-title-inline.mjs` UserPromptSubmit hook asks the live model
to emit an HTML comment marker (`<!-- bh-title: ... -->`) on the last line of
its response. The marker is invisible in markdown renderers (brainhouse's UI)
but renders literally in the user's CLI session, where brainhouse's pitch of
"seamless instrumentation" springs a visible leak.

The marker must live on the wire for the server-side parser to extract it;
stripping it server-side helps only brainhouse's own UI, not the user's
`claude` CLI output.

## Goal

Move title generation **out of band** — the server periodically asks a cheap
model (Haiku) to propose a title from transcript state the server already
ingests, with no instructions injected into the user's session and no marker
ever on the wire.

## Non-goals

- Cost metering for titler calls (defer; add later as a separate bucket from
  `hook_overhead_tokens`).
- Re-titling retired panels from the SQLite backfill. The titler operates on
  live `SessionManager` panels only.
- Per-account API key plumbing. One `ANTHROPIC_API_KEY` env var serves all
  panels in a brainhouse instance.

## Architecture

```
events ingested by session.ts
        │
        ▼
  scheduleEvaluation(panelId, kind)
        │
        ▼
   Titler (debounce + Stop trigger)
        │  (Haiku via Anthropic SDK)
        ▼
   applyAutoTitle(panelId, proposal)   ◄── existing path, unchanged
        │
        ▼
   panel_update delta + custom-title meta
```

### New module: `server/src/titler.ts`

A `Titler` class owned by `SessionManager`.

- **Construction:** lazy-init an `Anthropic` client from
  `process.env.ANTHROPIC_API_KEY`. Missing key → disabled state, logged once
  at startup. All public methods become no-ops.
- **Public surface:**
  - `scheduleEvaluation(panelId: string, reason: 'user_text' | 'assistant_text' | 'stop'): void`
  - `dispose(panelId: string): void` — clears any pending timer for a reaped
    panel.

### Trigger sites in `session.ts`

After event ingestion:

- `user_text` event with non-artifact body → `scheduleEvaluation(id, 'user_text')`.
- Substantive `assistant_text` event (text length > some small floor) →
  `scheduleEvaluation(id, 'assistant_text')`.
- Stop event observed by the watcher (hookEvents) → `scheduleEvaluation(id, 'stop')`.
  Stop is the strongest "this turn is done" signal and bypasses the debounce
  wait — fires immediately if eligibility gates pass.

Eligibility gates (mirror current inline hook):

- Pref `display.autoTitle` ON.
- Turn count ≥ 2 when no custom title exists yet.
- When a title exists, recheck every `RECHECK_EVERY_N_TURNS` boundary.

### Debounce behavior

Per-panel timer keyed by `panelId`. `user_text` / `assistant_text` reasons set
a fresh ~30s timer (resets on each call — coalesces bursts). `stop` reason
clears the timer and fires synchronously (after gates pass).

When a panel reaches eligibility but a request is already in flight for it,
the new request is dropped (single-flight per panel).

### Inputs sent to Haiku

A compact context envelope:

- First `user_text` (the initial intent).
- Last 2 substantive user/assistant_text turns (recent direction).
- Current title if any, for KEEP-vs-replace decision.
- System prompt: same word-cap (14) + sentence-case + describe-the-work
  rules the inline hook embeds today, minus marker-emission instructions.
  Stable across panels; tagged `cache_control: { type: 'ephemeral' }` so the
  prompt cache amortizes across calls.

Model: `claude-haiku-4-5`. `max_tokens: 64`.

### Output handling

Haiku returns a bare title string or the literal `KEEP`. Titler hands the
proposal directly to `manager.applyAutoTitle(panelId, proposal)` — same
dedupe, same delta routing.

If output is malformed (over word cap, contains quotes, contains newlines
after trim) the titler attempts a one-shot cleanup (trim, drop quotes, cap
to 14 words). If still malformed, drop silently and back off.

### Error / quota handling

- Missing `ANTHROPIC_API_KEY`: titler permanently disabled at startup,
  logged once. No errors raised.
- 401 at runtime: disable for the process lifetime, log once.
- 429 / 5xx: back off the panel's next eligibility by ~2 minutes.
- Network/timeout: retry once with 1s delay, then back off.

## Cleanup

- Delete `hooks/auto-title-inline.mjs`.
- Remove its entry from `hookRegistry()` in `bin/init.js`. Install summary
  table will reflect one fewer hook.
- **Keep** `client/src/transforms/builtIn/stripBhTitleMarker.ts` and the
  server-side marker-regex path in `session.ts` (~line 802). They become
  replay-only — they fire only for transcripts that contain the legacy
  marker. Add a one-line comment noting this.
- Keep `display.autoTitle` pref; its meaning shifts from "inline hook is
  enabled" to "server titler is enabled". Default stays ON.

## Testing

- Unit tests for `Titler`:
  - Debounce coalesces rapid `scheduleEvaluation` calls.
  - `stop` reason bypasses debounce.
  - Eligibility gates (placeholder-turn threshold, recheck cadence).
  - Single-flight: second eligible call while one is in flight is dropped.
  - 401 disables; 429 backs off; missing key no-ops.
- Integration: a fake Anthropic client returning canned titles, asserting
  that `applyAutoTitle` is reached and emits the expected delta.

## Migration / rollout

No data migration required. Behavior on first deploy:

1. Pre-existing panels with marker-driven titles keep their title — the
   server treats them as panels that already have a custom-title meta.
2. New panels acquire titles via the out-of-band path on the same cadence
   the inline hook used.
3. Users re-running `brainhouse init` will see the inline hook entry
   removed from their settings.json (the install summary table makes this
   visible). The marker is no longer emitted into their CLI output.

## Open question (resolved)

> "Should Stop events also fire the titler, in addition to the 30s
> quiet-debounce?"

**Yes.** Stop is the strongest "turn complete" signal; firing on it gives
the title parity-of-latency with the inline hook in the common case
(user asks, agent works, agent finishes).
