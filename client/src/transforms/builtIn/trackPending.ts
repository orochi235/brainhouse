/**
 * Maintains the "is the panel waiting on Claude?" flag. user_text and
 * tool_result set pending=true (the human or the tool just spoke);
 * only assistant_text clears it — tool_use means the model is still
 * mid-turn (about to call a tool and wait on the result), so pending
 * stays true across agentic tool loops until Claude produces a
 * user-visible reply.
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
    'Drives the thinking indicator + waiting badge. user_text / tool_result set pending=true; assistant_text clears it. tool_use does not clear — the model is still working through a tool loop.',
  matches: ['pending.bump'],
  run(event, _items, ctx) {
    if (event.kind === 'user_text' || event.kind === 'tool_result') ctx.scratch.pending = true;
    if (event.kind === 'assistant_text') ctx.scratch.pending = false;
  },
};
