# Brainhouse — behavioral assertions

A running list of declarative statements about how the app should behave.
These are intent records, not implementation notes: each entry is a rule the
UI/server is meant to uphold. New entries go at the bottom.

## UI

- When opening or restoring a session window, always scroll to the bottom
  — *unless* sessionStorage has a recent (<60s) saved scroll position for
  that panel, in which case restore the saved position. That exception
  exists only for the "page refresh" case; restoring a panel from the
  dock explicitly clears its saved position first, so dock-restores
  always snap to the bottom regardless of how recently it was hidden.
- When a session window receives an update, always scroll it to the bottom
  — unless the user has actively clicked inside that panel within the last
  30 seconds *and* the browser window currently has focus, or its state has
  been frozen (a forthcoming concept). If the browser window loses focus or
  the tab is hidden, every panel snaps to the bottom immediately.
- When the user cancels a query mid-turn (ctrl-c), the in-flight assistant
  bubble is grayed out and its contents are struck through; tool capsules
  that were part of the canceled work are dimmed.
- The next user_text after a `[Request interrupted by user]` marker is
  classified by its timestamp delta from the marker:
  - `< 3s` → **queued interrupt**: the user typed while the agent was
    working and ctrl-c'd to flush it. Treated as a continuation of the
    prior prompt — grafted onto the prior user bubble with a sawtooth
    tear.
  - `>= 3s` → **full interrupt**: the user composed a fresh follow-up
    later. An `interrupt-divider` view item is emitted ("user
    interrupted" centered between two rules), and the follow-up renders
    as its own user bubble.
- On reload, panels whose `last_event_at` is more than 30 seconds old are
  routed straight to the dock instead of the main grid.
- On reload, if the grid lands empty but the dock holds at least one
  panel whose status is `live`, those live dock panels are auto-restored
  to the grid. Fires at most once per page load — later state changes
  that leave the grid empty don't retrigger the restore.
- "Minimized for idleness" and "user-dismissed" are distinct intents. A
  panel that landed in the dock because it went idle or was stale on
  reload pops back to the grid automatically when new activity arrives.
  A panel the user explicitly dismissed stays in the dock until the user
  restores it, regardless of activity.
- The thinking indicator inherits the panel's hued theme color (matching the
  dominant bubble — assistant in default view, user in iMessage view).
- While a panel is actively waiting on a model response, the titlebar's
  session timer is replaced by a waiting badge showing a spinner and the
  elapsed time since the request was submitted.
- The `/clear` artifact trio that Claude Code emits at the top of a
  post-clear session — `<local-command-caveat>`, `<command-name>/clear`,
  `<local-command-stdout>` — is replaced by a single "prior session
  cleared" divider styled like the session-ended terminator. Caveat and
  stdout user_texts are dropped silently; only a command-name matching
  `/clear` produces the divider, so other slash commands still render.
- The non-live panel terminator reads "session cleared" instead of
  "session ended" when `ended_provenance === 'hook_session_start_supersede'`
  (i.e. the panel was retired by a follow-up `/clear` or `/compact`).
- Between two consecutive view-items whose timestamps fall on different
  local-calendar days, the pipeline inserts a `day-divider` view-item
  styled like the session-ended terminator (e.g. "Tuesday, May 26").
  Dividers are emitted only between real items — never leading,
  trailing, or two adjacent — so a day with no activity produces no
  divider. Owned by the `insertDayDividers` stage-2 transform.
- Each panel carries a `repo_root` field: the closest ancestor of its
  `cwd` containing a `.git` directory (or file, for worktrees).
  Resolved server-side via `findRepoRoot()` at panel creation and
  cached. Persisted in the panels table so a restart preserves it.
  Project widgets key on `repo_root` first so sessions run from
  arbitrary subdirectories of the same checkout cluster into one
  widget. `cwd`'s leaf segment is only used as a fallback for non-repo
  scratch directories.
- A panel whose title was explicitly set via `/rename` (any non-
  suppressed `custom-title` meta record) carries `manually_renamed:
  true` on its DTO and renders a `❖` (U+2756) glyph immediately before
  the title in both the grid header and the lightbox title. Once flipped
  the flag never clears — subsequent auto-titles don't affect it, and
  the flag round-trips through the persisted panels row.
- Timeline view is a third way to look at a slice of activity, parallel
  to Conversation and File. The `<Timeline>` component plots events
  (raw `Event`s) or view-items (coalesced) along a horizontal time
  axis, one lane + color per kind. Mouse interactions: hover → tooltip,
  click → drill into a detail pane, drag → brush a range (lists the
  contained items), scroll-wheel → zoom about the cursor. The component
  is container-agnostic — sized via ResizeObserver — so it can drop
  into any sized host (currently a panel-level lightbox + a tab inside
  OpStripLightbox; future hosts may include an inline panel slot or a
  top-level cross-panel route).
- Parent-panel title derivation ignores slash-command artifact user_texts
  (`<local-command-caveat>`, `<local-command-stdout>`, `<command-name>`,
  `<command-message>`, `<command-args>`). The panel keeps its short-id
  placeholder until the user's first real prompt arrives, which then
  becomes the title.
- Hook instrumentation overhead: each brainhouse hook that injects
  context (UserPromptSubmit `additionalContext`, SessionStart
  `additionalContext` / `initialUserMessage`) records its estimated
  token cost (~chars/4 proxy) via a `hook_overhead` side-channel record
  written by `hooks/lib/overhead.mjs`. The server accumulates these onto
  `panel.hook_overhead_tokens` and the context-size tooltip shows the
  absolute total plus its share of the current context window. Counter
  is in-memory; resets on server restart (re-accumulates as the watcher
  replays the side-channel JSONL).
- Agent-emitted retitle: a `meta` record with `record_type:
  'session-title'` and `raw.title` routes through the auto-title path
  (`panel_upsert`, synthetic `auto-title` breadcrumb, `auto_titled`
  cue). No string-heuristic on later `user_text` events — mid-session
  prompts routinely reference unstated context ("oh and that should
  also take a param like the other two"), so a length/word heuristic
  reliably degrades titles instead of improving them. Real re-titling
  needs context (LLM, agent self-report); until that's wired, only the
  explicit `session-title` meta channel re-titles in-band.
- Auto-titling (beta, gated on `experimental.autoTitle`): a Stop hook
  shells out to `claude -p` on the user's own CLI auth after each
  assistant turn. Fires when the panel has no `custom-title` meta yet
  AND the user has spoken ≥2 turns, OR periodically every 20 turns to
  catch drift. The model receives the first user prompt + last two
  turns and replies with either `KEEP` or a new title (≤14 words). On
  accept, the server emits a `panel_upsert` (title), an `event_append`
  with a synthetic meta event (`record_type: 'auto-title'`), and a
  transient `auto_titled` delta that drives a title-flash animation +
  a 5-second panel-anchored toast. The synthetic meta event renders
  inline as a permanent breadcrumb so the rename is auditable on reload.
- Debug mode (`debug.enabled`, off by default) gates dev affordances in
  the UI:
  - Topbar: `+ mock session`, `+ counter subagent`, Scenarios picker,
    Transforms picker, Flows viewer. `clear all`, Stats, connection
    status, theme toggle, and Prefs remain visible regardless.
  - Panel toolbar: `+sub` / `+count` (on parents) + `!title` (preview
    auto-title animations).
  The pref lives under a dedicated Debug section in the prefs modal.
- An `AskUserQuestion` tool_use renders as a synthetic assistant bubble
  (bolded question + bulleted options); the matching tool_result is
  swallowed rather than emitted as an orphan tool capsule. When the
  result is available, the answer is emitted as a *separate user-side
  bubble* immediately after the assistant bubble, so the exchange looks
  like a real chat turn (assistant asks, user replies). Single-question
  answers render as the chosen label(s) verbatim; multi-question forms
  render `Question → label` per line. Multi-select answers come through
  joined as comma-separated labels. A rejected/cleared result
  (`is_error`) renders the user-side bubble as `_(no answer)_`. Answer
  labels are not emphasized — they render as plain text.
- A `/btw` queued prompt detection flags the *next assistant bubble* as
  btw (left accent + "↩ btw" chip on the reply, not the prompt). The
  user bubble carrying the queued prompt renders plainly. Detection
  honors both of Claude Code's delivery shapes:
  - **Inline (Claude Code ≥ 2.1.13x):** the queued prompt arrives as an
    `attachment` record with `attachment.type === 'queued_command'`. No
    follow-up `type:user` record exists; the attachment IS the user
    input, and a plain user bubble is synthesized from
    `attachment.prompt`. `pendingBtwAssistant` is set so the following
    assistant bubble gets the chip.
  - **Deferred (older flow):** the queued prompt eventually arrives as a
    normal `type:user` record. A preceding `queue-operation` enqueue
    stashes the content; the matching user_text emits a plain user
    bubble and sets `pendingBtwAssistant`.
  All `queue-operation` records (enqueue/dequeue/popAll/remove) are
  consumed without rendering — they're queue bookkeeping. Non-`queued_command`
  `attachment` shapes (hook_success, hook_additional_context, …) are
  absorbed by the default-event handler. A non-/btw user_text (fresh
  prompt) clears any pending flag so a new turn doesn't inherit the
  chip.
- A manual `/clear` arms inherited-title suppression on the new
  session. Claude Code re-emits the prior session's `custom-title` into
  the fresh transcript; the first such record (and any identical
  subsequent ones) is dropped. The suppression ends on the user's first
  real `user_text` post-clear (slash-command artifacts like
  `<command-name>` do not count), or earlier if a *different*
  `custom-title` arrives — that's treated as an explicit `/rename` and
  honored immediately. `/compact` does not arm suppression (the
  conversation continues, so its title legitimately carries forward).
- Panels are not dimmed merely for going idle. A panel only dims after we
  have an explicit "this session is over" signal — currently, the
  SubagentStop hook on a subagent panel. The dim level is user-controlled
  via the Display prefs slider (defaults to 50%, floor 20%) and applies
  live via the `--idle-opacity` CSS custom property on `.panel.ended`.
- `thinking` events render as an *agent thought bubble* — a dashed-edged
  balloon with a two-dot tail, attributed to the assistant. Synthetic
  user_texts flagged `is_meta: true` that aren't absorbed onto a Skill
  capsule (i.e. the Claude-Code-injected residue we previously rendered
  as giant user bubbles) render as a *user thought bubble* in the user
  column. The `body.hide-thinking` pref hides agent thought bubbles
  alongside the legacy thinking row.

## Lifecycle

- A `SessionStart` hook with `source ∈ {clear, compact}` retires the prior
  live panel in the same project directory. "Same project directory" is
  determined by encoding each candidate panel's `cwd` (`/` and `.` → `-`)
  and matching against the basename of the new session's `transcript_path`
  dirname. The candidate must additionally be non-ended, kind=parent,
  not the new session itself, and have last activity within the last 5
  minutes. The most recently active match is ended with provenance
  `hook_session_start_supersede`; its live subagents are demoted and
  marked ended with the same provenance. `source ∈ {startup, resume}`
  never supersedes. After the dim, the panel (and any demoted subagents)
  are forced to `mini` 5 seconds later — bypassing the usual
  `done → mini` wait — *unless* the panel is pinned at fire time, in
  which case it stays dimmed in the grid. The auto-minimize step is
  gated by `prefs.workspace.autoMinimizeOnClear` (default on); flip it
  off to keep cleared sessions visible until the normal lifecycle
  ticks them down.

- A subagent panel (`kind === 'subagent'` with a `parent_panel_id`) has a
  `↗` pop-out affordance in its tool palette. Clicking it opens
  `?panel=<id>` in a new browser window named `brainhouse-panel-<id>`, so
  re-clicking the same panel focuses the existing window rather than
  spawning another. The popped-out window subscribes to the same delta
  stream and renders the panel via the focused-panel route.

- Path-shaped tokens in assistant/user bubbles, tool capsule labels, tool
  lightbox content, file-change rows, and the file-change lightbox title
  render as `filename-link` anchors that open in the user's configured
  editor. A path must contain `/` AND either include an extension on its
  last segment OR carry a `:line` suffix — bare-folder relative paths like
  `to/the` don't linkify. URL paths (`https://...`) are excluded. Inside
  fenced code blocks (`<pre>`) the text stays verbatim; inline `<code>`
  spans DO linkify (agents commonly write `` `src/foo.ts:42` ``). Relative
  paths resolve against the panel's `cwd`. `~/` is expanded against an
  explicit `home` if available, otherwise inferred from cwd
  (`/Users/<n>/...` or `/home/<n>/...`) — editor URL handlers don't expand
  `~` themselves. The editor URL template is a user pref
  (`editor.urlTemplate`) with `{path}`, `{line}`, `{col}` placeholders;
  an empty template disables the feature.

- A coalesced file-change row (multiple Read/Edit/MultiEdit/Write ops on
  the same path) shows an inline `+N −M` summary after the op-count
  breakdown (e.g. `1 read · 2 edits · +12 −4`). Counts come from
  `diffStats(reconstructFile(ops))` — per-hunk `diffLines` totals — so
  unchanged lines inside an edited region don't inflate the numbers.
  Read-only sequences omit the `+/−` (both zero).

- Within a single `MultiEdit` tool call, sub-edits that fall within
  `2 × CONTEXT_LINES` of each other collapse into one visual diff hunk
  in the lightbox. Sub-edits separated by a wider unchanged gap stay as
  separate hunks. Implemented by diffing the pre-MultiEdit snapshot
  against the post-MultiEdit snapshot (`splitDiffIntoHunks` in
  `fileSnapshot.ts`), so adjacency is measured in real line distance,
  not sub-edit ordering.

- The op-strip lightbox (compact one-liner between bubbles) supports two
  view modes via a header toggle: **conversation** (default — sub-items
  in original order) and **file** (file-changes regrouped by path, each
  rendered as stacked hunks; non-file ops collapse into a single "Also:
  N Bash · M Grep …" summary strip). Mode is session-local — resets when
  the lightbox closes. Single-file lightboxes (`FileChangeLightbox`)
  don't get the toggle since there's nothing to regroup.

- The panel-header token capsule headlines an **input-equivalent total**
  — each bucket weighted by its billing coefficient (input ×1,
  cache_create ×1.25, cache_read ×0.1, output ×5) — not a naive sum.
  The chip stays in token units; a $ estimate (via the per-model
  pricing table in `client/src/lib/tokenCost.ts`) appears only in the
  hover tooltip alongside per-bucket counts and the raw sum. The chip
  background color shifts to amber (`mixed`) or red (`poor`) when the
  cache hit rate `cache_read / (cache_read + cache_create + input)`
  drops below 70% / 40% respectively, gated on ≥50k cacheable tokens
  so fresh sessions don't read as broken.

- A parent panel held in mini past `removeAfterSeconds` is NOT reaped while
  any of its subagents (docked or broken-out) is still non-ended. The gate
  guards against orphaning the placeholder breadcrumb in the tray and
  against silently removing docked children whose work outlives the
  parent's own activity. Once every subagent is gone, the parent reaps on
  the next tick. Server-side, this lives in `session.ts:tick`'s mini→remove
  branch via `hasLiveSubagents()`.

- A panel is **only reap-eligible once it has actually ended** (`panel.ended`
  is true — set by Stop / SubagentStop / SessionEnd hooks, or by a
  follow-up `/clear` that supersedes the prior session). A still-alive
  session that simply went quiet ages through `live → done → mini` on the
  clock but stays in the tray indefinitely so the user can always see
  recent sessions regardless of how long ago they last did anything. The
  full slot-allocation rules (which decide grid vs tray placement on top
  of this lifecycle) are tracked in `TODO.md` under "Slot allocator".

- A subagent can be **broken out** of its parent's nested tray into the
  top-level grid (or dock, via a drag onto the mini strip). When broken
  out, the parent's tray renders a thin status-mirrored placeholder row in
  place of the panel; clicking the placeholder re-docks. The detached
  panel itself carries a `↩ <parent title>` breadcrumb chip in its
  subtitle row — clicking re-docks too. The drop-target for re-dock by
  drag is the entire parent's grid slot (the slot lights up
  `.redock-target`-green while a valid re-dock drag hovers it). The
  placeholder lives until the subagent re-docks OR the subagent panel is
  permanently removed. Click the `⇲`/`⇱` toolchip on a subagent for the
  click-equivalent of drag-to-grid / drag-to-parent.

- Meta-kind events (`subagent-meta`, `custom-title`, `last-prompt`,
  `ai-title`, `permission-mode`, `agent-color`, `pr-link`,
  `file-history-snapshot`, `attachment`, …) do NOT bump a done/mini panel
  back to `live`. They're sidecar metadata, not activity. Terminal close
  flushes a batch of these long after the session went idle; treating
  them as activity would resurrect retired panels. Only
  `user_text` / `assistant_text` / `tool_use` / `tool_result` /
  `thinking` / `resource_usage` / `system` events revive a non-ended panel.

- Every `Event` returned by `parseLine` carries a `tags: Tag[]` array
  computed at parse time. Downstream code (transforms, session-store
  activity checks, view renderers) should classify events via tags —
  `hasTag(event, 'meta')`, `hasTag(event, 'artifact')`, etc. — rather
  than re-deriving from `kind` / payload shape. Centralizing the
  classifier keeps Claude Code JSONL schema changes isolated to
  `parser.ts`. The full taxonomy lives in
  `docs/transforms-schema.md#event-tags`.

## State

- User **preferences** persist globally in `localStorage` (theme, debug
  toggle, workspace prefs, etc.).
- **Panel-scoped layout state** — panel order, wide / pinned / broken-out
  flags, client-mini / hidden routing — persists in the server-side
  `intentions` table, keyed by panel id, lifespan tied to the panel
  (rows disappear when the panel is reaped). Survives reload but not
  panel removal. Hooks: `usePanelDisposition` (panelOrder.ts) wraps the
  pinned / wide / broken-out sets; `usePanelDismissal` (hiddenPanels.ts)
  wraps the hidden / client-mini routing; `useIntentions` round-trips
  both to the server.
- **Awaiting-input notifications** fire on the false→true *transition*
  of `panel.awaiting_input`, not on steady state — a panel stuck
  awaiting for ten minutes never re-toasts, re-chimes, or re-flashes the
  title. Three channels are independently togglable in prefs
  (`notifications.tabTitleFlash`, `browserNotification`,
  `audibleChime`). Tab-title flash is the only one default-on (no
  permission cost); the others require explicit opt-in. Clicking a
  browser-toast focuses the brainhouse tab and scrolls the panel into
  view. The tab-title flash is a *steady-state* effect with two
  conditions (any awaiting panel AND `document.hidden`); it reverts the
  moment either clears.
- **Ephemeral UI state** — drag-hover ghosts, lightbox open/closed,
  scroll positions — lives in component state or `sessionStorage` and
  doesn't outlive the tab.
