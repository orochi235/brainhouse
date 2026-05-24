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

## Session names: update more frequently + more accurately
Today a parent panel's title is set once from the first user message and
locked in (`session.ts:maybeUpdateTitle`). Subsequent prompts, scope shifts,
or `/rename`-style retitling don't propagate. Subagent titles do better
(they pick up the `description` from `subagent-meta`), but parents stay
frozen on the original opening line — which is often "set up the project"
or "look at this bug" and rarely captures what the session actually became.

Possible signals to feed a better title:
- Latest user prompt (most-recent intent often beats first-prompt intent).
- Heuristic on the dominant tool mix (e.g. session that's mostly Bash on
  Docker files → "container debugging").
- LLM-derived 1-sentence summary, computed once per ~N turns or at session
  end — could share infra with `session_summary.key_decisions`.
- A `meta`-typed `session-title` record the agent itself emits ("I'm
  now working on X"). Pairs with the negotiated-interruption-points
  proposal — the agent already knows what it's doing; let it tell us.

Open questions:
- Show only the latest title, or layer them ("opened: setup → now: bug")?
- Manual override still wins (`custom-title` already works); make sure
  whatever auto-updater we add respects that.
- Update cadence: every turn is too noisy. Every N turns, or only when
  the heuristic confidence is high.

Pairs with: `session_summary` rollup, harvest-learnings flow.

## Universal object drag
Today drag-and-drop is piecemeal: dragging is only wired up where we've
explicitly opted in (grid reorder, mini→grid restore, mini panel ordering).
A subagent in a nested tray can't be dragged anywhere; a done panel can't
be picked up to reorder against live panels; ended panels can't be
dragged into the trash; etc.

Goal: **any session in any state can be picked up as a drag source, and
every plausible drop target accepts it pre-validation.** The drop site
decides at drop-time whether the move is meaningful (and renders a "no"
cursor or just no-ops if it isn't) — but the *attempt* should always be
expressible. This means:

- Drag handle on every PanelCard regardless of nested / live / done / mini
  / ended / pinned state.
- Drop targets: main grid (reorder + accept from anywhere), mini dock
  (demote-to-tray), parent's nested subagent tray (re-dock a broken-out
  subagent), trash button (move to bin), each individual panel header
  (could mean "merge" or "open relative to" — future).
- Common dataTransfer protocol: `text/brainhouse-panel` carries the id;
  `text/brainhouse-panel-source` carries the origin region. Each target
  validates source-vs-destination compatibility on drop.

Side benefit: re-attaching a broken-out subagent could just be a drag
back onto its parent's panel-subagents tray rather than a button click —
discoverable once the universal mechanic exists.

Open question: do we need a visual "ghost" preview at the drop target
before commit, or is the existing native drag-image enough? Probably
native + a `.drop-target` outline class (already used on grid slots).

## Session window drag-to-resize
Real tiling: drag edges/corners of a panel to give it more grid cells.
Persist the resize per panel id alongside the existing `wide` set (it would
generalize `wide` to arbitrary col/row spans). Needs grid-line snapping + a
small handle UI, plus a way to express "this panel spans 2 cols × 3 rows"
in the layout state.

## Tiled window management
Replace the auto-fill grid with a tiling layout: drag panels into slots, resize between rows, persist layout per project. Likely needs a dedicated layout state in `App.tsx` and a thin manager component.

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

## Token capsule: pricing-table maintenance
The headline number is now input-equivalent (sum × billing coefficient)
and the tooltip carries a $ estimate via a per-model pricing table at
`client/src/lib/tokenCost.ts`. The remaining work is keeping that
table in sync with Anthropic's published rates and extending the
prefix list as new model families ship. Consider a build-time pull
from a versioned source rather than a hand-maintained constant.

## Onboarding flow: install hooks + edit user prompts
We already have `brainhouse init` (in `bin/init.js`) that wires the
hook dispatcher into `~/.claude/settings.json`. There are two outstanding
gaps in how this lands for a new user:

1. **Hook installation should be more transparent.** Right now it
   writes a tagged hook entry; `--dry-run` exists but a normal user
   probably won't think to use it. First-run flow should:
   - Show *exactly* what's about to change (diff-style).
   - Make the entries reversible by name (already done via the
     `brainhouse: true` marker; surface this prominently).
   - Walk through *why* each hook is installed (Stop → instant idle
     detection, Notification → awaiting-input badge, etc.).

2. **Prompt-level additions** aren't tracked at all yet. As we collect
   conventions (the checklist convention, "did you learn anything"
   end-of-turn prompt, the agent self-assessment hints, the negotiated
   interruption point hints), each one is a *prompt* the user needs in
   their CLAUDE.md or skill file. Onboarding should optionally append
   these to the user's setup, again with a clear diff + reversibility.

Cautious + transparent design notes:
- Never modify user files without showing the diff first
- All brainhouse-owned text in user files gets a sentinel comment
  (`<!-- brainhouse:start -->` / `<!-- brainhouse:end -->`) so
  uninstall is mechanical
- Each addition is opt-in, not bundled — a user might want the hooks
  but not the prompt-level conventions, or vice versa
- A "what does brainhouse touch on my machine?" report at any time
  (`brainhouse status` or in the UI) so the user can always audit

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
Agents emit a ```brainhouse-checklist``` fenced block; we render it as a
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

## Title-bar timers / timestamps menagerie
Today the title bar shows one timer: live → elapsed-since-last-event, done/mini
→ `+5m`. There are several others that could be useful, and they're each
relevant in different states:

- **Session start** — when the parent session was first spawned (wall-clock
  or absolute).
- **Last user prompt** — useful for "how long has the agent been working
  unattended since my last input?"
- **Time in current state** — distinct from time-since-last-event. A live
  panel that's been busy for 20 minutes is different from one that's been
  idle 20 minutes.
- **Time-to-first-token** of the current turn (latency).
- **Active think/tool time** vs **idle/waiting** — sums for the whole session.
- **Hooks-observed end timestamp** — when SubagentStop / Stop actually
  fired, distinct from the "last event we ingested" wall-clock.
- **Time since pin** — for pinned panels, since they don't auto-demote.

Open question: which are valuable enough to surface by default vs which
belong in a tooltip / lightbox / hover-card. Probably one default + a
hover reveal for the rest. Pairs with the existing two-row meta layout
(could occupy the second row).

## Description-derived classification for subagents
`general-purpose` has no formal subtypes — every invocation just carries
a free-form `description` string ("Branch ship-readiness audit", "Find
callers of X", …). Different descriptions on identical
`agentType: general-purpose` panels read like categories, but there's no
structure to lean on for grouping / iconography / filtering today.

Options, roughly ordered by ambition:
- **Keyword chips.** Extract verbs from the description ("review",
  "find", "audit", "fix") and surface as small tags next to the title.
  Cheap, heuristic, no schema change.
- **Convention via brainhouse.** Ship a recommended prefix vocabulary
  (`review:`, `search:`, `audit:`, …) and document it. Programmers opt
  in by writing prompts that way; brainhouse renders the prefix as a
  real category badge. Matches the "design for programmers, expose
  primitives" lean.
- **Embed-and-cluster.** Embed each description and cluster across the
  session history. Principled, overkill for current volume.

Pairs with the agent-type icon work in `docs/claude-code-agents.md` —
that handles distinguishing built-in agents from each other; this
handles distinguishing many `general-purpose` dispatches from each other.

## Negotiated interruption points
The agent declares "ok to interrupt here" vs. "in the middle of an
atomic operation, please wait." Lets the user (or another agent) ctrl-c
without leaving the work in a half-done state. Pairs with the
`ended_provenance` work and could replace some of the dance around
SubagentStop.

## Detail layers for renderable artifacts
Generalize the "collapse noisy tool results" problem into a verbosity-level
system. Layers (rough): `summary` (one-line chip) → `standard` (current
panel view) → `full` (lightbox).

Classification axis: per *artifact type*, not per tool. e.g. "skill load",
"file read", "tool input", "tool result", "agent prompt", "agent final
message" — each gets a default level and is promotable/demotable. User can
shift the global floor or pin specific types.

Lightbox already exists (op-strip dual-view), so `full` view reuses it.
First concrete instance: skill-load tool results (entire SKILL.md dumped
inline today — should be a one-line chip with skill name + base dir,
expandable to full).

## Time-series stat keeping for sparkline charts
Today we only carry running totals per panel (lifetime `tokens`,
single-turn `context_size`). To draw mini-charts inside tooltips —
session token usage over time, context window growth, turn duration
trend — we need a per-panel time series.

Sketch:
- Server-side: append a sample on each `resource_usage` event
  (timestamp + buckets + context_size). Capped ring buffer (e.g. last
  200 samples) so memory stays bounded.
- Delta protocol: new `panel_sample` op, or fold into `panel_update`.
- Client: inline sparklines in the existing popovers (TokenTooltip
  gets a cumulative-spend trend; ContextSizeTooltip gets a window-size
  trend over the turn history; a SessionTimeTooltip extension could
  show per-turn duration).
- Open question: persistence. In-memory is fine for live sessions;
  serializing alongside panel state to disk would let us draw charts
  for retired sessions too.
