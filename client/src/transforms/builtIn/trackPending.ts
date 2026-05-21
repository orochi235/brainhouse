/**
 * Maintains the "is the panel waiting on Claude?" flag. user_text and
 * tool_result set pending=true (the human or the tool just spoke);
 * assistant_text and tool_use clear it (Claude is now talking back).
 *
 * Pass-through: never consumes the event. Just side-effects scratch state
 * so the runner can return `pending` in the final PreprocessResult.
 */

import type { Stage1Transform } from '../types.ts';

export const trackPending: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.track-pending',
  name: 'pending-indicator tracking',
  description:
    'Drives the thinking indicator + waiting badge. user_text / tool_result set pending=true; assistant_text / tool_use clear it.',
  run(event, _items, ctx) {
    if (event.kind === 'user_text' || event.kind === 'tool_result') ctx.scratch.pending = true;
    if (event.kind === 'assistant_text' || event.kind === 'tool_use') ctx.scratch.pending = false;
  },
};
