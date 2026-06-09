/**
 * Drops the synthetic "[Request interrupted by user]" user_text that
 * Claude Code emits when the user ctrl-c's mid-turn. Walks back through
 * the rendered items and marks the in-flight turn (everything between
 * the most recent user bubble and now) as canceled, so it dims in the UI.
 *
 * The next non-interrupt user_text is then handled by
 * `mergeInterruptedFollowup`, which attaches it to the prior bubble
 * with a sawtooth tear rather than starting a new bubble.
 */

import type { ViewItem } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

export const INTERRUPT_PATTERN = /^\[Request interrupted by user/i;

export const suppressInterruptMarker: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.suppress-interrupt-marker',
  name: 'suppressInterruptMarker',
  description:
    'Drops the synthetic "[Request interrupted by user]" user_text. Walks back to the last user bubble and marks every assistant/tool item between as canceled (dim + strikethrough).',
  matches: ['user-text.any'],
  run(event, items) {
    if (event.kind !== 'user_text') return false; // type narrowing
    if (typeof event.payload.text !== 'string') return false;
    if (!INTERRUPT_PATTERN.test(event.payload.text.trim())) return false;
    markCanceledTurn(items);
    return true;
  },
};

/** Walk backwards from the end of `items` and stamp `canceled: true` on
 * everything until the most recent user bubble (exclusive). Stops at a
 * previous interrupt boundary too, so back-to-back cancellations don't
 * cascade past the older one. */
export function markCanceledTurn(items: ViewItem[]): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type === 'bubble' && item.role === 'user') return;
    if (item.type === 'bubble' && item.canceled) return;
    if (item.type === 'bubble' || item.type === 'tool' || item.type === 'thinking') {
      item.canceled = true;
    }
  }
}
