/**
 * Default user_text handler: emits a user bubble. Also handles the two
 * shapes of "user_text that follows an interrupt marker":
 *
 *   - **Queued interrupt** — the user typed a message while the agent
 *     was mid-turn, hit ctrl-c to flush it. The queued user_text arrives
 *     immediately after the synthetic `[Request interrupted by user]`
 *     marker (sub-second gap). We treat this as a continuation of the
 *     prior prompt: graft the new text onto the prior user bubble with
 *     a sawtooth tear.
 *
 *   - **Full interrupt** — the user ctrl-c'd, then composed a fresh
 *     follow-up some time later. Gap from the interrupt marker is
 *     larger. We treat this as a *new* prompt: emit an
 *     `interrupt-divider` view item ("----- user interrupted -----")
 *     and then a fresh user bubble.
 *
 * Threshold: 3 seconds. Queued messages get a sub-second gap because
 * Claude Code injects them immediately on ctrl-c; manual follow-ups
 * typically take longer than that to type.
 *
 * Runs after `suppressInterruptMarker` (which drops the interrupt
 * marker event itself).
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';
import { INTERRUPT_PATTERN } from './suppressInterruptMarker.ts';
import { findLastBubble } from './util.ts';

const QUEUED_INTERRUPT_THRESHOLD_MS = 3_000;

export const userTextBubble: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.user-text-bubble',
  name: 'mergeInterruptedFollowup + user_text bubble',
  description:
    'Emits a user bubble. If the previous user_text was an interrupt marker, classifies as queued (<3s gap → sawtooth-graft onto prior bubble) or full (>=3s gap → emit `interrupt-divider` then a fresh bubble).',
  matches: ['user-text.any'],
  run(event, items, ctx) {
    if (event.kind !== 'user_text') return false; // type narrowing
    const text = event.payload.text ?? '';
    const interrupt = findPrecedingInterrupt(ctx.allEvents, event);
    if (interrupt) {
      // Draft-revision case: the prior user bubble was never answered
      // before the ctrl-c. Strike its existing text and append the new
      // text into the same bubble — the message reads as one revision
      // history, no sawtooth, no divider. Timing-independent because
      // "I never got a reply" is the load-bearing signal, not "I came
      // back quickly."
      const lastItem = items[items.length - 1];
      if (lastItem?.type === 'bubble' && lastItem.role === 'user') {
        for (const part of lastItem.parts) {
          if (part.kind === 'text') part.struck = true;
        }
        lastItem.parts.push({ kind: 'text', text });
        return true;
      }
      const gapMs = tsDeltaMs(interrupt.ts, event.ts);
      if (gapMs !== null && gapMs < QUEUED_INTERRUPT_THRESHOLD_MS) {
        const prev = findLastBubble(items, 'user');
        if (prev) {
          prev.parts.push({ kind: 'sawtooth' });
          prev.parts.push({ kind: 'text', text });
          return true;
        }
      } else {
        items.push({ type: 'interrupt-divider', ts: event.ts, anchorUuid: `${event.uuid}-int` });
      }
    }
    items.push({ type: 'bubble', event, role: 'user', parts: [{ kind: 'text', text }] });
    return true;
  },
};

/** If the most recent user_text before `current` is an interrupt marker,
 * return that event; otherwise null. (Skips non-user_text events — tool
 * results, assistant text, etc. — when scanning back.) */
function findPrecedingInterrupt(events: readonly Event[], current: Event): Event | null {
  for (let i = events.indexOf(current) - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== 'user_text') continue;
    if (typeof ev.payload.text !== 'string') return null;
    return INTERRUPT_PATTERN.test(ev.payload.text.trim()) ? ev : null;
  }
  return null;
}

function tsDeltaMs(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return tb - ta;
}
