# Bash terminal transform — design

Date: 2026-06-08
Status: approved

## Problem

Claude Code's `!cmd` shell-out emits a `user_text` event whose payload contains
`<bash-input>`, `<bash-stdout>`, and `<bash-stderr>` XML-tagged blocks. Today
these render as ordinary user bubbles, so a run of three or four `!ls` /
`!grep` commands fills the conversation with awkward wall-of-text bubbles
that bury the actual dialogue.

We want consecutive bash messages to coalesce into a single terminal-styled
view item that reads like a small terminal session.

## Scope

In scope:

- A new Stage 1 view transform that intercepts bash-tagged `user_text`
  events and emits a `terminal` ViewItem instead of the default user
  bubble.
- A `<TerminalCard>` renderer wired into the conversation switch.
- CSS styling for the terminal block.
- Unit tests for the transform's data behavior.

Out of scope:

- Per-source visual differentiation. The transform stamps a `source`
  hint on each entry so we can branch later, but for v1 all entries look
  the same.
- Output truncation / "show more" affordance. Long stdout uses whatever
  overflow treatment the existing assistant bubble uses.
- Handling bash blocks that arrive on `assistant_text` (none observed
  in current Claude Code output).

## Match rule

The transform fires when `event.kind === 'user_text'` AND the payload text
matches `/<bash-(input|stdout|stderr)>/`.

Parsing uses a generic capture `/<bash-([a-z-]+)>([\s\S]*?)<\/bash-\1>/g`
so any future variant (`<bash-result>` etc.) gets stored under
`entry.extras` rather than silently dropped. Known names route to
`input`, `stdout`, `stderr`; everything else lands in `extras`.

A `user_text` event with no bash tag is ignored — the transform returns
`false`, deferring to `userTextBubble`.

## View item shape

```ts
type TerminalEntry = {
  input: string | null;
  stdout: string | null;
  stderr: string | null;
  extras: Record<string, string>;
  source: 'cli-bang' | 'unknown';
  event: Event;
};

type TerminalItem = {
  type: 'terminal';
  anchorUuid: string;   // first entry's event.uuid
  entries: TerminalEntry[];
  ts: string;           // last entry's event.ts (for stage-2 ordering)
};
```

`source` is set to `'cli-bang'` when an `<bash-input>` is present (the
shape Claude Code produces from a `!cmd` user input), `'unknown'`
otherwise. v1 ignores this field for rendering; it exists so we don't
have to widen the type later when a second source appears.

Tag bodies are trimmed of leading/trailing whitespace but otherwise
preserved verbatim (no HTML escaping at the transform layer — the
renderer handles that).

## Coalescing

Per-event behavior inside the transform:

1. Parse the event into a `TerminalEntry`. If parsing yields nothing
   (no recognized bash tag found despite the regex match — shouldn't
   happen, but defensive), `return false`.
2. Look at `items[items.length - 1]`. If it is a `terminal` item, push
   the new entry into its `entries` array and update its `ts` to the
   new entry's `ts`. Return `true`.
3. Otherwise push a fresh `TerminalItem` with this entry as its only
   member. Return `true`.

Because any non-terminal item appended in between (a regular user
bubble, an assistant bubble, a tool capsule, etc.) will sit between two
bash events in `items`, the coalescing check naturally breaks runs at
the right place — no explicit "flush" logic needed.

## Registration

`client/src/transforms/registry.ts` — insert `bashTerminal` immediately
before `userTextBubble`, so it pre-empts the default user-bubble path
for these events.

## Renderer

New component: `client/src/components/TerminalCard.tsx`.

- Root: `<div class="terminal-card">` — dark monospace block sitting in
  the conversation flow at the position dictated by the item's
  anchor/timestamp.
- Each entry: `<div class="terminal-entry" data-source={entry.source}>`
  - If `entry.input`: `<div class="terminal-cmd"><span class="terminal-prompt">$</span> {entry.input}</div>`
  - If `entry.stdout`: `<pre class="terminal-stdout">{entry.stdout}</pre>`
  - If `entry.stderr`: `<pre class="terminal-stderr">{entry.stderr}</pre>`
  - For each `(name, body)` in `entry.extras`: `<pre class="terminal-extra" data-name={name}>{body}</pre>`
- Multi-entry items: a thin horizontal rule between adjacent entries
  (`.terminal-entry + .terminal-entry { border-top: ... }`).

CSS (`client/src/app.css`):

- `.terminal-card` — dark background, monospace font, rounded, padded,
  consistent with the existing bubble/tool-capsule visual rhythm.
- `.terminal-prompt` — dimmed accent color.
- `.terminal-cmd` — normal foreground, slightly bolder.
- `.terminal-stdout` — normal foreground, slightly dimmed.
- `.terminal-stderr` — red-tinted.
- `.terminal-extra` — fallback neutral.

## Wire-up

- `client/src/lib/pipeline-types.ts` — export `TerminalItem`,
  `TerminalEntry`. Add `'terminal'` to the `ViewItem` discriminated
  union.
- `client/src/components/EventList.tsx` — new switch arm rendering
  `<TerminalCard item={item} />`.
- `client/src/components/Timeline.tsx` — treat `terminal` items the
  same way `tool` items are treated for vertical-position calculation
  (use `item.ts`).
- `client/src/app.css` — add the styles listed above.

## Tests

`client/src/transforms/builtIn/bashTerminal.test.ts`:

1. Single event with `<bash-input>` + `<bash-stdout>` → one terminal
   item, one entry, both fields populated, `source === 'cli-bang'`.
2. Two consecutive bash events → one terminal item, two entries.
3. bash event → plain user_text → bash event → two terminal items
   separated by a bubble in the items array.
4. Event with only `<bash-stdout>` (no input) → entry with `input:
   null`, `source: 'unknown'`.
5. Plain user_text with no bash tag → transform returns `false`.
6. Unknown tag `<bash-foo>bar</bash-foo>` accompanying a real
   `<bash-input>` → captured under `entry.extras.foo`.

No renderer-level tests in v1 (consistent with how other ViewItem
renderers in this codebase are exercised — visual changes are
validated by running the dev server).

## Failure modes / edge cases

- **Malformed tag (unclosed)**: regex won't match, the transform
  returns `false`, the event falls through to the normal user bubble.
  Acceptable — preserves visibility of the broken data.
- **Bash event mixed with non-bash prose in the same `user_text`**: the
  bash bodies are extracted; surrounding prose is dropped. v1
  accepts this; in practice Claude Code never wraps bash output with
  prose.
- **Empty bodies** (`<bash-stdout></bash-stdout>`): trimmed string is
  empty → stored as `''`. Renderer treats falsy/empty as "not present"
  so the row doesn't render an empty `<pre>`.

## Future work (not in this spec)

- Per-source styling once a second `<bash-*>` producer exists.
- Collapsible long-output affordance.
- Click-to-copy on the command line.
- A renderer hook for ANSI escape sequences if any source emits them.
