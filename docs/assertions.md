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
- Parent-panel title derivation ignores slash-command artifact user_texts
  (`<local-command-caveat>`, `<local-command-stdout>`, `<command-name>`,
  `<command-message>`, `<command-args>`). The panel keeps its short-id
  placeholder until the user's first real prompt arrives, which then
  becomes the title.
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
- Panels are not dimmed merely for going idle. A panel only dims after we
  have an explicit "this session is over" signal — currently, the
  SubagentStop hook on a subagent panel. The dim level is user-controlled
  via the Display prefs slider (defaults to 50%, floor 20%) and applies
  live via the `--idle-opacity` CSS custom property on `.panel.ended`.

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
  which case it stays dimmed in the grid.

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

## State

- Only preferences persist in `localStorage`. Per-session UI state (panel
  order, wide/pinned flags, hidden/client-mini routing) is transient and
  lives in memory only.
