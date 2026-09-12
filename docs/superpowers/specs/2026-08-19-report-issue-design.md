# Report an issue about a session

Design for a per-panel "report issue" affordance in brainhouse. For
whoever maintains the feature next; assumes familiarity with the panel
model and the tRPC layer.

**The question it answers:** you notice a session rendering wrong and
want to hand a Claude Code session everything it needs to debug it,
without assembling the context by hand.

## Flow

Hover a panel → the tool palette fades in → click ⚑ → type what's wrong
→ Report. The server writes a markdown report to `~/.brainhouse/reports/`
and opens an iTerm2 window running `claude` in the brainhouse checkout,
seeded with that report as its first prompt.

## Entry point

A `ToolChip` in `PanelToolPalette` (`client/src/components/PanelCard.tsx`),
alongside the existing ⛶ (lightbox) and ⌁ (timeline) chips. Not
debug-gated — reporting is a normal user action. Mini panels have no
palette and get no chip; report from the restored panel.

## Modal

`client/src/components/ReportIssueModal.tsx`, opened via `useLightbox()`
with the panel's theme, matching `TransformsModal` and friends.

- Autofocused textarea.
- A read-only context line — title · session id · project — so it is
  unambiguous which panel is being filed against.
- Report / Cancel. Cmd+Enter submits; empty or whitespace-only text
  leaves Report disabled.
- Submit calls `reportIssue.mutate({ panelId, text })`. Success closes
  the lightbox. Failure keeps the modal open and shows the error, so a
  typed report is never lost to a dead server.

## Server

`server/src/reportIssue.ts`, wired to a `reportIssue` tRPC mutation.

Context comes from state that already exists:

| Field | Source |
|---|---|
| panel snapshot | `store.panel(panelId)` |
| transcript path | `monitor.sourceFileForPanel(panelId)` |
| brainhouse revision | `git rev-parse HEAD` in the checkout |

The snapshot contributes id, kind, parent panel id, title, agent type,
status, `cwd`, `repo_root`, account label, and the timestamps as ISO
strings. No event dump — the report points at the JSONL and lets the
troubleshooting session read as much of it as it needs.

The mutation returns `{ reportPath, launched }`.

### Report file

`~/.brainhouse/reports/<iso-timestamp>-<panelId>.md`, overridable with
`BRAINHOUSE_REPORTS_DIR` — the same shape as the image store in
`server/src/images.ts`. Reports persist so there is a greppable trail
rather than a prompt that evaporates.

Three sections: the reporter's text verbatim, a `## Context` block, and
a `## Task` instruction telling the reader it is in the brainhouse
checkout, that it should read `CLAUDE.md` and `docs/assertions.md`
first, and that its job is to find the root cause of the described
behavior in that session.

### Launch

`~/.brainhouse/reports/launch.sh`, rewritten on every report so it can
never drift from the current checkout path:

```sh
cd <repoRoot>
claude "$(cat "$1")"
```

`repoRoot` derives from the server's own module path, not a hardcoded
location.

`osascript` then creates a **bare** iTerm2 window, waits for its shell,
and types `'<launcher>' '<report>'` at the prompt with `write text`.

Creating the window `with … command` instead would replace the login
shell with that command, so it starts before the profile has loaded and
`claude` is not yet on `PATH` — the failure this design exists to avoid.
Typing into the shell iTerm already started means a normal interactive
login shell with the user's real environment, and it leaves a re-runnable
line in the scrollback. The cost is having to wait for that shell:
`is at shell prompt` is the shell-integration signal, polled for up to
10s, with a 1.5s settle as the fallback for installs without it.

Paths reach AppleScript as `argv` entries rather than interpolated
source, the same discipline `revealItermSession` uses in
`server/src/processes/native.ts`.

### When the window can't open

Non-macOS, iTerm2 absent, or `osascript` failing yields
`launched: false` and an `error` string, with the report still written.
The modal shows both plus the launcher command to run by hand. Losing
the terminal must never lose the report.

The error is reported rather than swallowed because the first Apple
Event the server sends is gated on a macOS Automation consent prompt for
the launchd process; until it is granted, `osascript` fails with nothing
on stderr, and a bare `launched: false` gives no way to tell that from a
bug.

## Tests

Vitest over the pure parts:

- `renderReport` includes the reporter's text, the session id, and the
  transcript path; a null transcript path degrades to a stated "not
  found" rather than the string `null`.
- `launchScript` keeps a repo path containing spaces quoted, and does not
  `exec` a replacement shell — the window's own shell survives, because
  the command is typed at its prompt rather than replacing it.
- `itermCommand` is a bare quoted invocation, with single quotes in a
  path escaped rather than ending the quoted string.
- The modal sends trimmed text to the mutation, disables Report on empty
  input, and on `launched: false` shows the path and the reason.

The `osascript` call is untested, matching `revealItermSession`.

## Out of scope

Screenshots of the panel, GitHub issue filing, and any in-app list of
past reports. The directory is browsable and that is enough until it
isn't.
