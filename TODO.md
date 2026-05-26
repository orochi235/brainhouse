# brainhouse — project todos

## Awaiting-input notifications — follow-ups

Initial pass shipped: tab-title flash (default on), browser
`Notification` toast (opt-in, permission prompted on flip), and a
WebAudio chime (opt-in). All gated on the false→true `awaiting_input`
transition; see `client/src/lib/useAwaitingNotifications.ts` and the
prefs assertion in `docs/assertions.md`.

Still on the table (no urgency):
- **Favicon badge / dot.** Cheap visual on the tab strip, complements
  the title flash. Needs a small canvas-favicon helper.
- **OS-level notification via a server-side helper** (`osascript` /
  `notify-send`). More reliable than the browser API but adds platform
  branching; only worth it if the browser path proves unreliable.
- **Panel-level wake-up.** When the flag flips on, scroll the panel
  into view and pulse it — useful even with brainhouse in the
  foreground. Currently we only do this on toast click.

## [HIGH] Auto-title marker is a visible seam in non-markdown renderers

The inline `<!-- bh-title: ... -->` marker the auto-title hook asks
the model to emit is invisible in browser/markdown contexts (its
whole design conceit) but renders literally in CLI output, where
brainhouse's pitch of "seamless instrumentation" springs a leak.

The marker has to live on the wire for the server to parse it from
JSONL. Stripping it server-side before display only helps
brainhouse's own UI; it does nothing for the user's `claude` CLI
session printing the response text.

Options worth considering:
1. **Move auto-title back to a Stop hook** that runs `claude -p`
   on a longer cadence. Invisible to all renderers but expensive
   (~50k tokens per invocation due to harness boot — the cost was
   why we moved to inline).
2. **Sentinel tool_use the server intercepts**. Have the model
   call a no-op `BhSetTitle` tool with the title in `input`. CLI
   still renders tool capsules though, so this trades a comment
   leak for a tool-call leak — arguably worse.
3. **Out-of-band server-side titler**: server reads
   assistant_text + last_prompt periodically, runs its own
   small-model summarization without involving the in-band turn.
   Adds infra (cheap LLM client, queue) but is the only truly
   seamless option.
4. **Live with it**. Marker is short, fires only every Nth turn.
   The leak is small; weigh against build cost of #3.

If brainhouse positions itself as seamless, a visible side channel
is the wrong default. Lean toward #3 (or a cheap local variant —
e.g. a Haiku call) when there's time.

## Project widgets

Scaffolding landed: one card per observed repo, auto-derived from the
cwds of currently-loaded panels. Same outer dimensions as a session
`PanelCard`, body is intentionally empty for v0. Lives at
`client/src/lib/projectWidgets.ts` + `components/ProjectWidgetCard.tsx`,
rendered in the grid after session cards (`App.tsx`). Counts as
additional cells in `useGridLayout`; **not** part of the slot allocator
— widgets have self-contained visibility rules.

Open follow-ups:
- **[NEXT] Server-side backfill from session_summary**. Today the
  widget enumerates projects + computes stats from the in-memory
  `panels` map only — so a repo whose sessions have all reaped
  vanishes from the UI, and historical stats are lost. The
  architecture should layer-cake (not swiss-cheese): SQLite →
  server tRPC → client hook → widget, no cross-cuts.

  Implementation sketch:
    1. `server/src/store.ts`: new query `getProjectRollups()` that
       hits `session_summary` (already has `cwd`, `started_at`,
       `ended_at`, `account_label`, `unique_files_touched`,
       `event_count`, `title`). Group by `cwd` at the SQL layer;
       client collapses worktrees → repo via `deriveWorktree`.
       Return shape:
         - `cwdRollups: { cwd, sessionCount, fileCount,
            accountLabel, lastEventAt }[]`
         - `recentSessions: { sessionId, title, cwd, accountLabel,
            startedAt, endedAt }[]` (cap ~200, most-recent first)
    2. `server/src/trpc.ts`: `projects.rollup` query procedure.
    3. `client/src/lib/projectWidgets.ts`: replace
       `buildProjectRollups(panels)` with a hook
       `useProjectRollups()` that fetches via tRPC, then *merges*
       in-memory `panels` for live sessions (which aren't in
       session_summary yet — they materialize on
       end-of-session). Merge rule: a session present in both
       (rare — only for ended-but-still-loaded panels) prefers
       the in-memory copy for freshest status/title.
    4. Re-fetch policy: once on mount, once per N minutes (or on
       window focus). The data shifts only on session-end, so
       polling at panel-tick cadence is overkill.

  **Multi-account collision** (load-bearing): a single repo can
  have sessions under multiple accounts over time (e.g.
  `simpluris` had .claude commits 38 days ago, switched to
  .claude-pw recently). Group-by-repo MUST pick the *most-recent*
  `account_label` per repo, not the oldest, not a list. The
  client-side rollup already does latest-wins for theme/cwd; the
  server query should do the same for accountLabel: take it from
  the row with `MAX(ended_at)` per cwd, then on the client take
  it from the most-recent cwd per repo.

  **Tokens**: not in `session_summary` today. Either add a
  `total_tokens REAL` column (cheap; populate from
  `panel.tokens` at materialize time) or compute on demand from
  `events_index` resource_usage rows. Adding the column is the
  simpler call. Migration: column is nullable, existing rows
  get null, new rows populate. Display: show "—" when null.

- **Content**: activity sparkline, key files surfaced from
  `key_files_json`, last-prompt summary surfaced from
  `key_decisions`. All already in `session_summary`.
- **Exclusions pref**: UI in prefs to hide specific projects.
- **Cold-project rule**: optionally only show widget when the
  project has had no activity in N days. Today it's always-on.
- **Pin / hide via intentions**: pseudo-id `project:<repo>` is
  safe to share with `panel_id` in the intentions table.

## [HIGH] Slot allocator: keep recent sessions visible, fill voids

Replace the purely time-based `live → done → mini → reap` lifecycle as
the sole driver of grid vs tray placement. Current behavior:
- A still-running session that goes idle ages through done→mini→removed
  on the clock, even though the process is alive.
- An empty grid with a couple of mini tiles produces a big black void
  when no work is currently in flight.

Design: lifecycle still tracks `live`/`done`/`mini` server-side
(useful as visual hints + reaping signal), but **placement** is decided
by a client-side slot allocator that fills a target of N grid slots.

Priority order (top wins):
0. **Pinned** panels — always primary. Hard rule; pins override
   everything else including the slot cap. If pins exceed N, all pins
   still render and the fill step is skipped.
1. **Live unpinned** panels — always primary, as many as exist.
2. **Fill remaining slots** with closed/idle panels via per-project
   round-robin (most-recent first):
   - Pass 1: most-recent panel per project.
   - Pass 2: second-most-recent per project.
   - …until slots are full.
   If only one project has activity, all slots fill from it (no quota
   holds a slot open for an absent project).
3. **Overflow** → mini tray. Includes user-dismissed and user-mini'd
   panels regardless of allocator opinion.

Reaping (server-side) — separate concern: only ended panels are
eligible. A `mini` panel whose `panel.ended === false` lingers
indefinitely; the allocator decides if it's primary or tray. Gate lives
in `session.ts:tick`'s `mini → remove` branch alongside the existing
`hasLiveSubagents` guard.

Open questions:
- **N**: target slot count. Start with a constant (6?), revisit if it
  should track viewport width.
- **Project key**: cwd's repo segment, or worktree key? Different
  worktrees of the same repo are arguably one project for fill purposes
  (diversify across repos) but separate for the existing
  group-by-worktree layout. Lean toward repo-level key for the
  allocator; group-by-worktree is orthogonal.
- **Staleness cutoff**: should a week-old cross-project panel still
  beat a fresh same-project one in pass 1? Probably yes; revisit if it
  feels wrong.
- **Process-dead detection**: a crashed session whose Stop hook never
  fired keeps `ended=false` and so never reaps. Acceptable for now (it
  just sits in the tray); future: a periodic `kill -0 <pid>` sweep
  flipping `ended='process_dead'`.
- **done→mini transition**: today this is also time-based. With the
  allocator, mini is mostly cosmetic (the tray location is determined
  by overflow). Leaving the time-based demotion alone for now; revisit
  if it feels redundant.

Replaces/refines these existing assertions in `docs/assertions.md`:
- "On reload, panels whose `last_event_at` is more than 30 seconds old
  are routed straight to the dock" — keep, but the allocator can pull
  recent ones back if slots are empty.
- "On reload, if the grid lands empty but the dock holds at least one
  panel whose status is `live`, those live dock panels are
  auto-restored" — subsumed by the allocator (live unpinned always
  claim slots).

## Coalesce file ops — richer diff rendering
Basic coalescing already lands (`coalesceFileOps()` in `pipeline.ts`
groups Read/Edit/Write/MultiEdit runs on the same path into a
`file-change` row). LCS-based split-pane diff rendering is in
(`DiffTable.tsx` via the `diff` package), inline `+N −M` shows on the
file-change row (`diffStats()` in `fileSnapshot.ts`), and MultiEdit
sub-edits within `2 × CONTEXT_LINES` of each other now merge into one
hunk (split only when the unchanged gap is wide enough to warrant it).

Open follow-ups:
- Extend the same merging to consecutive *separate* Edit ops on the
  same file (today each Edit still renders as its own hunk in the
  lightbox; only the within-one-MultiEdit case is merged).
- Per-op `+N −M` chips in the lightbox header (currently only the
  per-file total shows; per-op gives finer-grained diff readability).

## Session names: more signals
Heuristic re-title from later substantive `user_text` events + an
agent-emitted `session-title` meta record are wired (see assertions).
Remaining ideas:
- Tool-mix heuristic ("mostly Bash on Docker files → container
  debugging") — cheap but signal/noise unclear; revisit if titles still
  feel stale in practice.
- LLM-derived summary on a longer cadence (every ~N turns) — would
  share infra with `session_summary.key_decisions` / the Stop-hook
  `experimental.autoTitle` flow that already exists.
- Layered title display ("opened: setup → now: bug") instead of
  replace-in-place. Cheap to try once we have stronger signals to layer.

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
Per-session usage is wired (tokens + context_size on PanelDto, capsule
in the header, tooltip breakdown). Hook instrumentation overhead is also
tracked separately (`hook_overhead_tokens`, via the side-channel records
each brainhouse hook writes through `hooks/lib/overhead.mjs`).

Still open:
- Rate-per-minute while live + per-project rollup ("~3M tokens in
  ~/src/foo this week"). Needs session_summary to carry the totals so
  the rollup survives panel reaping.
- Cost estimates — need a model-pricing table; either hard-code (and
  keep it stale) or pull from a maintained source.
- Per-project budget prefs that flash the panel when crossed.
- Foreign-hook overhead estimation (option #2 from the discussion):
  detect hook-injected text in the JSONL even when it's not from a
  brainhouse hook. Speculative until we see overhead-from-other-hooks
  matter in practice.

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

## Replay debug tools (Phase 2: scrubber)

Phase 1 shipped: `/?replay=<abs path>` and global drag-and-drop of
`.jsonl` files render one read-only `PanelCard` driven by
`server/src/replay.ts`. The view pipeline (`runViewPipeline`) is reused
unchanged, so this already exercises every transform against any saved
transcript. Trash + dev affordances are gated behind a new
`readOnly` prop on PanelCard.

Phase 2 adds a scrubber so we can step through a transcript event by
event and see what the transforms produce at each cut. Cheap because
`runViewPipeline` is pure with respect to its input array.

### Goals
- Slider above the panel: index 0..events.length. Default = full.
- Each scrubber change re-runs `runViewPipeline(events.slice(0, N))`.
  Memoize by N so the common forward/backward dragging is fast.
- Keyboard: `←`/`→` step one event, `Shift+←`/`Shift+→` jump to the
  nearest `user_text` boundary, `Home`/`End` for 0 / max.
- Show the virtual `now` in the header chip — derive from the
  current event's `ts` rather than wall-clock, so "idle for 3s" etc.
  reflect the moment captured in the transcript.
- Mark `user_text` indexes as tick marks under the slider — they're
  the most useful coarse stops (turn boundaries).

### Implementation sketch
- New component `ReplayScrubber` inside `ReplayView.tsx`; lifts
  `events` from `ReplayView` state and slices before passing to
  `PanelCard`.
- PanelCard already recomputes its pipeline from `panel.events` on
  every render via `preprocessEvents` — no extra hook needed. If
  performance bites for large transcripts (>5k events), memoize the
  sliced array by index inside `ReplayView` and pass a stable
  reference.
- Virtual-`now` is trickier: PanelCard reads `Date.now()` directly
  in a few places (`now` state, `useTitleFlash`). Cleanest fix is a
  new optional `nowOverride?: number` prop that, when set, replaces
  the `setInterval`-driven `now`. Replay mode passes
  `events[N-1].ts` parsed to seconds.
- Tick marks: extract `user_text` indexes from `events`, render as
  absolutely-positioned tick `<span>`s inside the slider track.

### Open questions
- Persistence: should the scrubber position survive reload? Probably
  yes for the path-based form (URL query `?at=<index>`); inline /
  drag-dropped sessions have no stable identity so they reset.
- Do we want a "play" button that auto-advances at 1× / 4× / 16×
  speed? Useful for watching a session unfold, but easy to add
  later — first deliver the static scrubber.
- Subagent transcripts: the scrubber today only operates on the
  parent JSONL. To replay a parent + its subagents together (so the
  nested-tray rendering works) we'd need to load multiple files
  and merge events by timestamp. Deferred — single-file replay
  already covers the transform debugging use case.

### Phase 3 preview
Pairs naturally with "transforms-as-diagrams (#2 live pipeline trace)"
above: once the scrubber exists, an event-by-event side panel showing
"which transform handled this event, what items it pushed, what
scratch state changed" is a small extension. The trace data is already
within reach inside `runViewPipeline`; we'd just need to plumb a
trace-recording option through the runner.

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

## Use the tool-use `description` field for capsule summaries

Most tool_use messages carry a `description` field with a short
plain-English summary the model wrote alongside the call (e.g. Bash
descriptions like "List files in current directory", Edit's "Rename
foo → bar"). Today our tool capsules render the tool name + a
truncated `input` blob; the model-authored description is right there
and is almost always a better at-a-glance label.

Wins:
- Cheaper-to-scan transcripts — readers don't have to parse a JSON
  input to figure out what a tool call did.
- Free i18n / phrasing — the model already adapts the description to
  the actual call.
- Especially useful for Bash (where `command` is opaque) and Agent
  (where the description is *the* point of the call).

Implementation sketch:
- Parser already preserves the raw tool_use payload; surface
  `description` on the view-item.
- Capsule renderer: when `description` is present, show it as the
  primary label and demote the raw input to the expand-on-click body.
  Fall back to current behavior when absent.
- Decide what to do when `description` and `input` disagree (rare but
  possible) — probably show both, with `description` on top.
