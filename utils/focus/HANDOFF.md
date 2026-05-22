# claude-focus — terminal-focus tracking for the brainhouse aggregator

Lets the brainhouse aggregator highlight whichever session-div corresponds to
the terminal window/tab the user is currently typing in.

## Why this exists

Claude Code hooks don't fire on terminal focus or per-keystroke — only on
discrete lifecycle events (`SessionStart`, `UserPromptSubmit`, `Stop`, etc.).
`UserPromptSubmit` works as a "recent activity" proxy but lags real focus
changes by however long the user spends typing. This module reads focus from
the OS side (Hammerspoon) and writes a single file the aggregator can tail.

## How it works

1. **Session-start hook** (`claude-focus-register`) writes a registry entry at
   `~/.claude/focus/registry/<session_id>.json` and emits an `OSC 2`
   sequence that sets the terminal window/tab title to
   `claude:<session_id> — <cwd-basename>`.
2. **Hammerspoon module** (`claude-focus.lua`) subscribes to `windowFocused`
   and `windowTitleChanged` events across all apps. When the focused
   window's title matches `claude:<session_id>`, it atomically writes
   `<session_id>\t<unix_ms>\n` to `~/.claude/focus/active`. Empty file = no
   Claude session focused.
3. **Session-end hook** (`claude-focus-unregister`) removes the registry
   entry and clears the active file if it pointed at this session.
4. **Aggregator (brainhouse)** tails `~/.claude/focus/active` and highlights
   the matching div.

The OSC title approach is terminal-agnostic: iTerm2, Terminal.app, Ghostty,
Alacritty, kitty all honor it, and Hammerspoon reads window titles
regardless of which app owns them. Tab switches inside iTerm2 fire
`windowTitleChanged` on the same window, so they're covered.

## Files

All three artifacts live here in `~/src/brainhouse/utils/focus/` and are
referenced in-place — no copying into `~/bin/` or `~/.hammerspoon/`. Keeping
them in the repo means edits are version-controlled and the canonical copy
is unambiguous.

| File | Role |
|---|---|
| `claude-focus-register` | `SessionStart` hook (executable) |
| `claude-focus-unregister` | `SessionEnd` hook (executable) |
| `claude-focus.lua` | Hammerspoon module (loaded via `package.path`) |

The scripts shell out to `python3` for JSON parsing — no `jq` dep.

## State

Everything lives under `~/.claude/focus/` to avoid colliding with Claude
Code's own `~/.claude/sessions/` dir.

```
~/.claude/focus/
├── registry/
│   └── <session_id>.json    # one per live session: pid, ppid, tty, cwd, started_at_ms
└── active                   # single line: <session_id>\t<unix_ms>\n  (empty = nothing focused)
```

`active` is always replaced via `write tmp + rename` for atomic reads.

## Install

### 1. Load the Hammerspoon module in-place

Add to `~/.hammerspoon/init.lua` (before any other `require` of this
module):

```lua
package.path = package.path .. ';' .. os.getenv('HOME') .. '/src/brainhouse/utils/focus/?.lua'
require('claude-focus')
```

Reload Hammerspoon (menu bar → Reload Config).

### 2. Wire the hooks in `~/.claude/settings.json`

Point the commands at the in-repo scripts:

```json
"SessionStart": [
  { "hooks": [{ "type": "command", "command": "/Users/mike/src/brainhouse/utils/focus/claude-focus-register" }] }
],
"SessionEnd": [
  { "hooks": [{ "type": "command", "command": "/Users/mike/src/brainhouse/utils/focus/claude-focus-unregister" }] }
]
```

No `matcher` on the focus entry — `SessionStart` fires on `startup`,
`resume`, `clear`, and `compact`, and we want the title re-stamped on all of
them (compaction in particular can otherwise lose state).

### 3. Verify

```sh
# Start a fresh Claude session, then in another pane:
cat ~/.claude/focus/registry/*.json    # should contain your live session
tail -F ~/.claude/focus/active         # click between windows; line should flip
```

The terminal window/tab title should also visibly change to
`claude:<session_id> — <basename>`.

## Aggregator contract

- Watch `~/.claude/focus/active` (fsevents / inotify, or `tail -F`).
- File is replaced atomically — read the whole file each event.
- Format: `<session_id>\t<unix_ms>\n` or empty.
- Empty = no Claude window focused (e.g. user is in a browser).
- `session_id` is the Claude Code session id, which is also what brainhouse
  receives in its own dispatcher hooks — they map 1:1.

## Known limitations / follow-ups

- **Prompt themes that rewrite the title.** zsh `precmd` / starship /
  oh-my-zsh themes may overwrite the OSC 2 title. Symptom: registry entry
  exists but title no longer shows `claude:...`, so Hammerspoon writes
  empty. Fixes, in order of effort:
  1. Configure the prompt to leave the title alone for Claude sessions
     (gate on `$CLAUDE_SESSION_ID` if it's exported).
  2. Add an `iTerm2 user var` path — `\e]1337;SetUserVar=claude_session=<b64>\a` from
     `SessionStart`, read via iTerm2's Python API. User vars survive prompt
     rewrites. iTerm-only.
  3. PID-walk fallback: Hammerspoon → focused window's tty → match against
     `registry/*.json:tty`. Terminal-agnostic but more fragile.
- **Brainhouse fold-in.** Right now the register/unregister scripts are
  standalone. Brainhouse already owns a hook dispatcher
  (`hooks/dispatcher.mjs`); these could move under it once we have a
  `SessionStart` / `SessionEnd` route there, eliminating the two extra hook
  invocations.
- **Multi-pane terminals (tmux).** If a single terminal window hosts
  multiple Claude sessions via tmux panes, the window title only reflects
  the active pane's title — which is fine for focus, but the title may
  flicker as tmux's status updates fight the OSC 2 emission. Not exercised
  yet.
- **Race on rapid focus changes.** Hammerspoon writes are debounced only by
  the `lastWritten` short-circuit. A storm of focus events could theoretically
  interleave with the aggregator's read; the atomic rename keeps reads
  consistent, but the aggregator should treat any old `unix_ms` as stale.
- **No teardown on Hammerspoon reload.** Re-`require`-ing the module leaks
  the previous `hs.window.filter` subscriptions. Cosmetic; restart
  Hammerspoon if it starts behaving oddly during iteration.

## History

Drafted 2026-05-21. Originals were written into `~/bin/` and
`~/.hammerspoon/` first, then relocated here as the canonical home. Install
recipe updated to load in-place from this directory so the repo copy is
authoritative.
