# brainhouse — project todos

## Coalesce file ops — richer diff rendering
Basic coalescing already lands (`coalesceFileOps()` in `pipeline.ts`
groups Read/Edit/Write/MultiEdit runs on the same path into a
`file-change` row). What's missing:

- Inline `+N -M` summary on the file-change row (currently just "N
  operations · 2 Edit, 1 Write")
- A real LCS-based diff renderer in `FileChangeLightbox.tsx` instead of
  the current naive "before lines, then after lines" stack. The `diff`
  package is the obvious dep.
- Smarter handling of MultiEdit: collapse multiple sub-edits into one
  visual hunk where the regions are adjacent.

## Session window drag-to-resize
Real tiling: drag edges/corners of a panel to give it more grid cells.
Persist the resize per panel id alongside the existing `wide` set (it would
generalize `wide` to arbitrary col/row spans). Needs grid-line snapping + a
small handle UI, plus a way to express "this panel spans 2 cols × 3 rows"
in the layout state.

## Tiled window management
Replace the auto-fill grid with a tiling layout: drag panels into slots, resize between rows, persist layout per project. Likely needs a dedicated layout state in `App.tsx` and a thin manager component.

## AskUserQuestion: render the user's choice
We currently transform an `AskUserQuestion` tool call into an assistant
bubble showing the question + every option. We *don't* indicate which
option the user actually picked (or that they wrote a custom answer),
so the bubble reads like an unanswered open question even after the
turn moved on.

Plan: read the matching `tool_result` payload — it contains
`{ answers: { <question>: <selected-label> }, annotations? }` — and
either (a) decorate the chosen option in the bubble (✓ on the row, or
the un-chosen ones dim/strikethrough), or (b) render a compact "answer:
<label>" footer below the question. Variant (b) is simpler and handles
multi-select naturally. If the user added free-text notes via the
"Other" path, surface those too.

Implement in `pipeline.ts:formatAskUserQuestion` — it already swallows
the `tool_result` via `absorbedToolUseIds`; instead, pass the result
through to the formatter and include the chosen labels in the rendered
markdown.

## Token usage: metering, counting, budgets
Surface per-session token usage as a first-class signal. Claude Code writes
usage info into the JSONL on every API response (input/output token counts,
cache hits, model id) — pipe that through to brainhouse so each panel
shows: tokens consumed so far this session, rate-per-minute while live,
running cost estimate at posted model prices, and a per-project rollup
("you've burned ~3M tokens in ~/src/foo this week").

Concrete pieces:
- Parser: extract `usage` block from assistant messages into a new
  `ResourceUsage` event kind (or a side-channel on assistant_text)
- Session store: accumulate input/output/cache totals + model used on the
  Panel; surface via PanelDto
- UI: small "tokens" capsule in the panel header (next to the idle/waiting
  badge); click → modal with the breakdown + cost estimate
- session_summary: persist the totals so the per-project rollup works
  beyond the events_index retention window
- Optional: per-project budget prefs that flash the panel when crossed
- Tricky: cost estimates need model-pricing table; either hard-code (and
  keep it stale) or pull from a maintained source

This pairs naturally with #9 (schema/pipeline buildout) since the
`usage` field is one of the higher-value passthrough records.

## Nag the user when a session is awaiting input
The Notification hook already populates `awaiting_input: true` on panels
that are blocking on the user (e.g. permission required, AskUserQuestion
pending), and we render a small badge in the header. That's easy to miss
when brainhouse is in a background tab or another monitor.

Want: a more assertive nudge that's hard to miss but still respectful.
Candidates, mix-and-match:
- Tab-title flash: prepend "● " to `document.title` when *any* panel is
  awaiting; revert when none are.
- Browser `Notification` API: native OS toast, gated on `Notification.
  permission === 'granted'`. Requires a permission prompt the first
  time; pref to enable.
- Audible chime, off by default, pref to enable.
- "Awaiting input" pulse on the favicon (some sites do this; tasteful).
- A panel-level wake-up: bring the awaiting panel into view + briefly
  highlight when the flag flips on. Probably worth doing regardless of
  the cross-tab nudges.

Per the design-principles doc, the prefs surface here should accept the
user picking *which* of these they want, not be one hard-coded behavior.

## Transforms-as-diagrams
Visualize the event → view-item pipeline as a flowchart-style diagram —
nodes for transforms, edges for the event/view-item kinds that flow
through them, ideally in a format we can compose smaller diagrams out of
to explain individual scenarios.

Three flavors of increasing effort, all worth doing eventually:

1. Static Mermaid diagrams in `docs/`. Trivial. Reference doc.
2. Live pipeline trace for a specific panel: which transform handled
   each event, what view item came out. `preprocessEvents` would need a
   trace mode that emits records alongside its outputs.
3. Composable diagram-of-diagrams: each transform is a reusable node;
   build per-scenario explainers by snapping nodes together. Bigger
   engineering (probably d3 or react-flow); pays off when we want to
   explain a specific weird transcript.

User clarification: "more in line with something like a flowchart that
shows what comes in, what transforms it, and what goes out, and ideally
in a format where we could compose diagrams out of many of those."

## Token capsule: weight by cost, don't sum naively
The token capsule in the panel header currently displays an unweighted
sum of `input + output + cache_create + cache_read`. That number is
misleading-by-overstatement: cache reads dominate the sum in typical
Claude Code sessions and are billed at ~0.1× the input rate, while
output is ~5× input. So a session showing "1.7M tokens" might actually
cost the same as a session showing "200k" depending on the mix.

Anthropic's posted rates (subject to drift; need a maintained source):
- input            1.00×
- cache_creation   1.25×
- cache_read       0.10×
- output           ~5×    (varies by model)

Proper fix lands with cost estimation: headline becomes "~$X" via a
pricing table keyed on `tokens.model`, and the tooltip keeps the
per-bucket breakdown we already have. Interim option if cost estimation
is far off: display two numbers in the headline ("5k+200k cache") so
the cache portion is visibly distinct from the input-equivalent part,
or label the existing number as a raw sum so users don't read it as a
cost proxy.

## Schema / pipeline buildout
Continue extending `preprocessEvents` to interpret newer record types as Claude Code adds them. Inventory current passthrough `meta` records (we already saw `custom-title`, `agent-name`, `subagent-meta`, `permission-mode`, `agent-color`, `pr-link`, `queue-operation`, `file-history-snapshot`, `attachment`, `last-prompt`) and decide which deserve first-class rendering.

---

# Communication enhancements — parent agent ↔ subprocess

Open-ended list of conventions/protocols that would let parents (and
brainhouse, as the viewer) understand what a subprocess is *doing* and
*needs* with higher fidelity than "another assistant_text bubble landed."

Some of these are things Claude Code itself would need to adopt; others
are just rendering conventions brainhouse can recognize if the agent
follows them. Treat this list as a wishlist + design scratchpad, not
ready-to-implement.

## Checklists (already partial)
Agents emit a ```pensieve-checklist``` fenced block; we render it as a
pinned progress list above the transcript. Already working but could go
further:
- Distinguish "intended plan" vs "ad-hoc todo" — the former is the
  starting commitment, the latter is mid-stream additions.
- Surface the *delta* between checklist revisions (added/removed items)
  in the bubble itself, not just by replacing the pin.
- Per-item time-elapsed so a stuck item is obvious.

## Progress updates beyond checklists
For long-running work that isn't naturally checklist-shaped (e.g., "I'm
running tests, here's the rolling pass/fail count"). Today the agent
either spams assistant_text or stays silent. Want:
- A convention for "status only" updates that brainhouse renders as a
  single replaceable line (not stacked bubbles).
- Numeric progress (`{done: 23, total: 100}`) that we can show as a bar.
- "What I'm waiting on" hints (`waiting on: external API`,
  `waiting on: long-running build`) so the user knows the silence is
  expected.

## Agent self-assessment: expectation + urgency
Two signals the agent often *knows* but doesn't communicate:

- **Does this turn expect a reply?** Sometimes the agent finishes a
  thought and a reply is welcome; other times it's mid-task and a reply
  would derail it. A small `expects_reply: bool | 'optional'` hint
  would let brainhouse de-emphasize panels that aren't blocking on
  anyone.
- **Is this urgent?** Catastrophic-looking results (test failure, lint
  red, deploy stuck) and "I need a human decision right now" beats
  vs. "background progress" should be distinguishable. An `urgency:
  'info' | 'attention' | 'blocking'` hint would feed the
  awaiting-input nag system.

These pair with the "nag the user when a session is awaiting their
input" TODO above — both are about brainhouse knowing *how loudly* to
surface a panel's state.

## Subprocess intent / "what am I trying to accomplish"
Subagents have a `description` field on creation (the parent's prompt
to them). It'd be useful to also surface what the *subagent itself*
thinks it's doing — a self-summary it updates as the work evolves.
Lets the parent (and brainhouse) understand drift: "the goal was X but
the subagent is now off doing Y."

## Confidence / uncertainty signals
A way for the agent to say "I'm doing this but not confident about it
— check my work" vs. "this is well-trodden, no need to re-verify." Maps
naturally to a per-bubble or per-tool-call badge.

## Cost projections (forward-looking, not historical)
We have *backward-looking* token totals (the resource_usage work above).
The forward-looking equivalent would be an agent saying "this next step
will probably need ~50k more tokens." Lets the user kill a session
early when it's about to spiral.

## End-of-turn: "did you learn anything worth remembering?"
At session end (or at any natural breakpoint — a checkpoint, a long
chunk of work shipping), prompt the agent to self-report:
*"what did you learn here that's worth carrying forward?"* — then route
those nuggets somewhere durable. Brainhouse-shaped homes for them:

- per-project memory file (e.g. `<cwd>/.claude/learnings.md`)
- the user's global memory if it's generally applicable
- a `session_summary.learnings` JSON field so they're queryable later
  ("show me everything I've learned about this codebase across the
  last 6 months")

Pairs with the existing `key_decisions` field on session_summary but
fundamentally different: decisions are about *the work*, learnings are
about *the world* (a constraint we hit, a quirk of the codebase, a
non-obvious convention, a teammate's preference). Agents often
implicitly know these and never write them down; explicitly asking
flushes them out.

UI piece: at session-end (or via a manual "harvest learnings" button on
a panel), brainhouse shows whatever the agent volunteered and lets the
user accept/edit/discard each item before it gets written to memory.
The accept-before-write step matters — agents will sometimes volunteer
things that aren't actually worth remembering.

## Negotiated interruption points
The agent declares "ok to interrupt here" vs. "in the middle of an
atomic operation, please wait." Lets the user (or another agent) ctrl-c
without leaving the work in a half-done state. Pairs with the
`ended_provenance` work and could replace some of the dance around
SubagentStop.
