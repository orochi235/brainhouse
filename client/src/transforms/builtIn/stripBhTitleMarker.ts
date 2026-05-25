/**
 * Strip the inline auto-title marker (`<<bh-title>>X</bh-title>>`) from
 * assistant text before downstream transforms render the bubble.
 *
 * The marker is emitted by the model in response to the
 * `auto-title-inline.mjs` UserPromptSubmit hook's `additionalContext`
 * instruction. The server extracts it for the actual title application
 * (see `maybeProposeAutoTitle` in server/src/session.ts); this transform
 * just hides it from the rendered transcript.
 *
 * Mutates `event.payload.text` in place so `assistantTextBubble` sees
 * the cleaned text. Pass-through (returns false) — the event still flows
 * to subsequent transforms.
 */

import type { Stage1Transform } from '../types.ts';

export const BH_TITLE_MARKER_RE = /\n*<<bh-title>>[\s\S]*?<\/bh-title>>\s*$/;

export const stripBhTitleMarker: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.strip-bh-title-marker',
  name: 'stripBhTitleMarker',
  description:
    'Removes the trailing `<<bh-title>>...</bh-title>>` side-channel marker from assistant_text so the inline auto-title prompt never leaks into the UI.',
  run(event) {
    if (event.kind !== 'assistant_text') return false;
    const text = event.payload.text;
    if (typeof text !== 'string' || !text.includes('<<bh-title>>')) return false;
    const cleaned = text.replace(BH_TITLE_MARKER_RE, '').trimEnd();
    event.payload.text = cleaned;
    return false;
  },
};
