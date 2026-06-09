/**
 * Strip the inline auto-title marker (`<!-- bh-title: X -->`) from
 * assistant text before downstream transforms render the bubble.
 *
 * The marker is emitted by the model in response to the
 * `auto-title-inline.mjs` UserPromptSubmit hook's `additionalContext`
 * instruction. HTML-comment form keeps it invisible in any markdown
 * renderer (Claude Code's own UI included), so this transform is
 * belt-and-suspenders — the marker shouldn't reach the renderer either
 * way, but stripping it removes the literal text from search, copy, etc.
 *
 * The server extracts the marker for title application; see
 * `maybeProposeAutoTitle` in server/src/session.ts.
 *
 * Mutates `event.payload.text` in place so `assistantTextBubble` sees
 * the cleaned text. Pass-through (returns false) — the event still flows
 * to subsequent transforms.
 */

import type { Stage1Transform } from '../types.ts';

export const BH_TITLE_MARKER_RE = /\n*<!--\s*bh-title:[\s\S]*?-->\s*$/;

export const stripBhTitleMarker: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.strip-bh-title-marker',
  name: 'stripBhTitleMarker',
  description:
    'Removes the trailing `<!-- bh-title: ... -->` side-channel marker from assistant_text so the inline auto-title prompt never leaks into the UI.',
  matches: ['assistant-text.bh-title'],
  run(event) {
    // Selector ensures kind=assistant_text + body contains 'bh-title:'.
    if (event.kind !== 'assistant_text') return false;
    const text = event.payload.text;
    if (typeof text !== 'string') return false;
    const cleaned = text.replace(BH_TITLE_MARKER_RE, '').trimEnd();
    event.payload.text = cleaned;
    return false;
  },
};
