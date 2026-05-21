/**
 * Default user_text handler: emits a user bubble. Also covers the
 * "interrupted followup" case — when a user_text directly follows an
 * interrupt marker, we don't start a new bubble but instead append the
 * new text to the prior user bubble with a sawtooth tear between.
 *
 * Runs after `suppressInterruptMarker` (which drops the interrupt itself).
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';
import { INTERRUPT_PATTERN } from './suppressInterruptMarker.ts';
import { findLastBubble } from './util.ts';

export const userTextBubble: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.user-text-bubble',
  name: 'mergeInterruptedFollowup + user_text bubble',
  description:
    "Emits a user bubble. If the previous user_text was an interrupt marker, attaches this text to the prior user bubble with a sawtooth tear instead of starting a new one.",
  run(event, items, ctx) {
    if (event.kind !== 'user_text') return false;
    const text = event.payload.text ?? '';
    if (wasPrevUserAnInterrupt(ctx.allEvents, event)) {
      const prev = findLastBubble(items, 'user');
      if (prev) {
        prev.parts.push({ kind: 'sawtooth' });
        prev.parts.push({ kind: 'text', text });
        return true;
      }
    }
    items.push({ type: 'bubble', event, role: 'user', parts: [{ kind: 'text', text }] });
    return true;
  },
};

function wasPrevUserAnInterrupt(events: readonly Event[], current: Event): boolean {
  let sawInterrupt = false;
  for (let i = events.indexOf(current) - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.kind !== 'user_text') continue;
    if (typeof ev.payload.text !== 'string') return false;
    if (INTERRUPT_PATTERN.test(ev.payload.text.trim())) {
      sawInterrupt = true;
      continue;
    }
    return sawInterrupt;
  }
  return false;
}
