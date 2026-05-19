/**
 * Event → view-item transform pipeline.
 *
 * Mirrors the late-pensieve RENDER_TRANSFORMS chain. Walks the panel's full
 * event list once and returns a list of "view items" that EventList renders.
 * Each transform here corresponds to one named function in the pensieve
 * pipeline; ordering matters and matches the pensieve order.
 */

import type { Event } from '@server/parser.ts';
import type { ToolResultPayload, ToolUsePayload } from './tools.ts';

export type BubblePart = { kind: 'text'; text: string } | { kind: 'sawtooth' };

export type ViewItem =
  | { type: 'bubble'; event: Event; role: 'user' | 'assistant'; parts: BubblePart[] }
  | {
      type: 'tool';
      anchorUuid: string;
      use: ToolUsePayload | null;
      result: ToolResultPayload | null;
      ack: string | null;
      ts: string;
    }
  | { type: 'thinking'; event: Event }
  | { type: 'system'; event: Event }
  | { type: 'meta'; event: Event };

export interface PreprocessResult {
  items: ViewItem[];
  /** The most recent ```pensieve-checklist block found in any bubble. */
  checklist: ChecklistItem[] | null;
  /** True if the panel is currently awaiting Claude's reply (user → no asst yet). */
  pending: boolean;
}

export interface ChecklistItem {
  done: boolean;
  text: string;
}

const INTERRUPT_PATTERN = /^\[Request interrupted by user/i;

export function preprocessEvents(events: Event[]): PreprocessResult {
  const items: ViewItem[] = [];
  let checklist: ChecklistItem[] | null = null;
  let pending = false;

  for (const event of events) {
    // ---- pending-indicator tracking (user/tool_result start → pending; asst/tool_use clear) ----
    if (event.kind === 'user_text' || event.kind === 'tool_result') pending = true;
    if (event.kind === 'assistant_text' || event.kind === 'tool_use') pending = false;

    // ---- checklist scan: most recent ```pensieve-checklist block wins ----
    if (
      (event.kind === 'user_text' || event.kind === 'assistant_text') &&
      typeof event.payload.text === 'string'
    ) {
      const found = extractLastChecklist(event.payload.text);
      if (found) checklist = found;
    }

    // ---- mergeToolResultIntoCapsule ----
    if (event.kind === 'tool_result') {
      const id = event.payload.tool_use_id;
      const target = id ? findToolItem(items, id) : null;
      if (target) {
        target.result = event.payload;
        continue;
      }
      // Orphan tool_result — render as a tool item with no use.
      items.push({
        type: 'tool',
        anchorUuid: event.uuid,
        use: null,
        result: event.payload,
        ack: null,
        ts: event.ts,
      });
      continue;
    }

    // ---- tool_use → new capsule ----
    if (event.kind === 'tool_use') {
      // upgradeOrphanCapsule: did we render an orphan with this id?
      const id = event.payload.tool_use_id;
      const orphan = id ? findToolItem(items, id) : null;
      if (orphan && !orphan.use) {
        orphan.use = event.payload;
        continue;
      }
      items.push({
        type: 'tool',
        anchorUuid: event.uuid,
        use: event.payload,
        result: null,
        ack: null,
        ts: event.ts,
      });
      continue;
    }

    // ---- suppressInterruptMarker ----
    if (
      event.kind === 'user_text' &&
      typeof event.payload.text === 'string' &&
      INTERRUPT_PATTERN.test(event.payload.text.trim())
    ) {
      // mark a "pending merge" so the next user_text knows to attach
      continue;
    }

    // ---- mergeInterruptedFollowup ----
    if (event.kind === 'user_text') {
      const prevInterrupt = wasPrevUserAnInterrupt(events, event);
      const text = event.payload.text ?? '';
      if (prevInterrupt) {
        const prevBubble = findLastBubble(items, 'user');
        if (prevBubble) {
          prevBubble.parts.push({ kind: 'sawtooth' });
          prevBubble.parts.push({ kind: 'text', text });
          continue;
        }
      }
      items.push({
        type: 'bubble',
        event,
        role: 'user',
        parts: [{ kind: 'text', text }],
      });
      continue;
    }

    // ---- foldToolAck: short assistant_text right after a tool is an ack ----
    if (event.kind === 'assistant_text') {
      const text = (event.payload.text ?? '').trim();
      const last = items[items.length - 1];
      const isShort = text && text.length <= 200 && !text.includes('\n\n') && !text.includes('```');
      if (isShort && last?.type === 'tool') {
        last.ack = text;
        continue;
      }
      items.push({
        type: 'bubble',
        event,
        role: 'assistant',
        parts: [{ kind: 'text', text: event.payload.text ?? '' }],
      });
      continue;
    }

    if (event.kind === 'thinking') items.push({ type: 'thinking', event });
    else if (event.kind === 'system') items.push({ type: 'system', event });
    else if (event.kind === 'meta') items.push({ type: 'meta', event });
  }

  return { items, checklist, pending };
}

function findToolItem(
  items: ViewItem[],
  toolUseId: string,
): Extract<ViewItem, { type: 'tool' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (
      item?.type === 'tool' &&
      ((item.use && item.use.tool_use_id === toolUseId) ||
        (item.result && item.result.tool_use_id === toolUseId))
    ) {
      return item;
    }
  }
  return null;
}

function findLastBubble(
  items: ViewItem[],
  role: 'user' | 'assistant',
): Extract<ViewItem, { type: 'bubble' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === 'bubble' && item.role === role) return item;
  }
  return null;
}

function wasPrevUserAnInterrupt(events: Event[], current: Event): boolean {
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

export function extractLastChecklist(text: string): ChecklistItem[] | null {
  const re = /```pensieve-checklist\s*\n([\s\S]*?)```/g;
  let last: ChecklistItem[] | null = null;
  let m: RegExpExecArray | null;
  while (true) {
    m = re.exec(text);
    if (!m) break;
    const items: ChecklistItem[] = [];
    const body = m[1] ?? '';
    for (const line of body.split('\n')) {
      const im = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
      if (im?.[1] !== undefined && im[2] !== undefined) {
        items.push({ done: /[xX]/.test(im[1]), text: im[2] });
      }
    }
    if (items.length) last = items;
  }
  return last;
}
