/**
 * Coalesce consecutive `<bash-*>`-tagged user_text events into a single
 * `terminal` view item. Claude Code emits these for `!cmd` shell-outs as
 * `<bash-input>` plus `<bash-stdout>` / `<bash-stderr>` blocks; left to the
 * default user-bubble path they pile up as wall-of-text bubbles. Here a
 * run of them becomes one terminal-styled block with each command + its
 * output as a row inside.
 *
 * Runs break naturally: when any non-terminal item lands in `items`
 * between two bash events, the next bash event sees a non-terminal at
 * the tail and starts a fresh `terminal` item.
 *
 * Must run before `userTextBubble` so it pre-empts the default
 * user-bubble emit for bash events.
 */

import type { TerminalEntry, TerminalItem, ViewItem } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

const BASH_TAG_PROBE = /<bash-(?:input|stdout|stderr)>/;
const BASH_TAG_CAPTURE = /<bash-([a-z-]+)>([\s\S]*?)<\/bash-\1>/g;

export const bashTerminal: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.bash-terminal',
  name: 'bash-tagged user_text → terminal item',
  description:
    'Parses user_text events containing <bash-input>/<bash-stdout>/<bash-stderr> blocks into a single coalesced `terminal` view item. Consecutive bash events fold into the same item; any non-terminal item between them breaks the run.',
  run(event, items) {
    if (event.kind !== 'user_text') return false;
    const text = event.payload.text ?? '';
    if (!BASH_TAG_PROBE.test(text)) return false;
    const entry = parseEntry(event, text);
    if (!entry) return false;
    const last: ViewItem | undefined = items[items.length - 1];
    if (last && last.type === 'terminal') {
      last.entries.push(entry);
      last.ts = event.ts;
      return true;
    }
    const item: TerminalItem = {
      type: 'terminal',
      anchorUuid: event.uuid,
      entries: [entry],
      ts: event.ts,
    };
    items.push(item);
    return true;
  },
};

function parseEntry(event: { uuid: string }, text: string): TerminalEntry | null {
  let input: string | null = null;
  let stdout: string | null = null;
  let stderr: string | null = null;
  const extras: Record<string, string> = {};
  let found = false;
  // Iterate all <bash-NAME>BODY</bash-NAME> blocks. Reset lastIndex to
  // 0 because BASH_TAG_CAPTURE has the `g` flag and lives at module
  // scope.
  BASH_TAG_CAPTURE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BASH_TAG_CAPTURE.exec(text)) !== null) {
    found = true;
    const name = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    if (name === 'input') input = body;
    else if (name === 'stdout') stdout = body;
    else if (name === 'stderr') stderr = body;
    else extras[name] = body;
  }
  if (!found) return null;
  return {
    input,
    stdout,
    stderr,
    extras,
    source: input !== null ? 'cli-bang' : 'unknown',
    event: event as TerminalEntry['event'],
  };
}
