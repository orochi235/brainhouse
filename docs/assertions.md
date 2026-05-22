# Brainhouse — behavioral assertions

A running list of declarative statements about how the app should behave.
These are intent records, not implementation notes: each entry is a rule the
UI/server is meant to uphold. New entries go at the bottom.

## UI

- When opening or restoring a session window, always scroll to the bottom
  — *unless* sessionStorage has a recent (<60s) saved scroll position for
  that panel, in which case restore the saved position. That last
  exception only matters for the "page refresh" case; a panel reopened
  from the dock minutes later still snaps to the bottom because the
  saved position has aged out.
- When a session window receives an update, always scroll it to the bottom
  — unless the user has actively clicked inside that panel within the last
  30 seconds *and* the browser window currently has focus, or its state has
  been frozen (a forthcoming concept). If the browser window loses focus or
  the tab is hidden, every panel snaps to the bottom immediately.
- When the user cancels a query mid-turn (ctrl-c), the in-flight assistant
  bubble is grayed out and its contents are struck through; tool capsules
  that were part of the canceled work are dimmed.
- On reload, panels whose `last_event_at` is more than 30 seconds old are
  routed straight to the dock instead of the main grid.
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
  never supersedes.

- Path-shaped tokens in assistant/user bubbles, tool capsule labels, tool
  lightbox content, file-change rows, and the file-change lightbox title
  render as `filename-link` anchors that open in the user's configured
  editor. A path must contain `/` AND either include an extension on its
  last segment OR carry a `:line` suffix — bare-folder relative paths like
  `to/the` don't linkify. URL paths (`https://...`) are excluded. Inside
  fenced code and inline `<code>` spans the text stays verbatim. Relative
  paths resolve against the panel's `cwd`. The editor URL template is a
  user pref (`editor.urlTemplate`) with `{path}`, `{line}`, `{col}`
  placeholders; an empty template disables the feature.

## State

- Only preferences persist in `localStorage`. Per-session UI state (panel
  order, wide/pinned flags, hidden/client-mini routing) is transient and
  lives in memory only.
