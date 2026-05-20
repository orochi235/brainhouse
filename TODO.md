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

## Schema / pipeline buildout
Continue extending `preprocessEvents` to interpret newer record types as Claude Code adds them. Inventory current passthrough `meta` records (we already saw `custom-title`, `agent-name`, `subagent-meta`, `permission-mode`, `agent-color`, `pr-link`, `queue-operation`, `file-history-snapshot`, `attachment`, `last-prompt`) and decide which deserve first-class rendering.
