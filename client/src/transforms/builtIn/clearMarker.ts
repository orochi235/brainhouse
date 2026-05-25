/**
 * Replaces the `/clear` artifact trio that Claude Code emits at the top
 * of a post-clear session — `<local-command-caveat>`, `<command-name>/clear</command-name>`,
 * `<local-command-stdout>` — with a single "prior session cleared"
 * divider, styled like the session-ended terminator.
 *
 * Caveat and stdout artifacts are dropped silently (they're system noise
 * with no user-visible content). Only the command-name carrying `/clear`
 * produces the divider, so other slash commands still render normally.
 */

import { hasTag } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';

const CAVEAT_ONLY = /^\s*<local-command-caveat>[\s\S]*<\/local-command-caveat>\s*$/;
const STDOUT_ONLY = /^\s*<local-command-stdout>[\s\S]*<\/local-command-stdout>\s*$/;
const CLEAR_COMMAND = /<command-name>\/clear<\/command-name>/;

export const clearMarker: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.clear-marker',
  name: 'clearMarker',
  description:
    'Converts `/clear` command artifacts into a "prior session cleared" divider and drops the surrounding caveat/stdout noise.',
  run(event, items) {
    if (event.kind !== 'user_text') return false;
    // Artifact tag is the fast-bail gate; the user's normal prompts
    // (no artifact tag) skip the regex work entirely.
    if (!hasTag(event, 'artifact')) return false;
    const text = event.payload.text;
    if (typeof text !== 'string') return false;
    if (CAVEAT_ONLY.test(text) || STDOUT_ONLY.test(text)) return true;
    if (hasTag(event, 'slash_command') && CLEAR_COMMAND.test(text)) {
      items.push({ type: 'cleared', event });
      return true;
    }
    return false;
  },
};
