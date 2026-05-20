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

export interface ToolItem {
  type: 'tool';
  anchorUuid: string;
  use: ToolUsePayload | null;
  result: ToolResultPayload | null;
  ack: string | null;
  ts: string;
  /** True when the user pressed ctrl-c mid-turn and this tool's call was
   * part of the canceled work. Rendered dimmed. */
  canceled?: boolean;
}

export interface FileChangeItem {
  type: 'file-change';
  /** First op's uuid — used as the React key + lightbox anchor. */
  anchorUuid: string;
  path: string;
  /** Original tool ops in order. Each is a fully-resolved use+result pair. */
  ops: ToolItem[];
  /** Latest op's timestamp. Used for the row's time gutter + idle ordering. */
  ts: string;
}

/** Runs of non-bubble items between two bubbles compress into this. */
export interface OpStripItem {
  type: 'op-strip';
  anchorUuid: string;
  items: ViewItem[];
  ts: string;
}

export type ViewItem =
  | {
      type: 'bubble';
      event: Event;
      role: 'user' | 'assistant';
      parts: BubblePart[];
      canceled?: boolean;
    }
  | ToolItem
  | FileChangeItem
  | OpStripItem
  | { type: 'thinking'; event: Event; canceled?: boolean }
  | { type: 'system'; event: Event }
  | { type: 'meta'; event: Event };

/** Tool names whose inputs touch a single file via `input.file_path`. These
 * are the ops eligible for `coalesceFileOps()`. */
export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

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
      // Mark the in-flight turn as canceled. Walk back to the most recent
      // user bubble; everything between (assistant bubbles, thinking,
      // tool capsules) was part of the work the user ctrl-c'd.
      markCanceledTurn(items);
      // Drop the synthetic marker itself — the next user_text will pick up
      // the sawtooth via mergeInterruptedFollowup below.
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
    else if (event.kind === 'meta') {
      // Absorbed-by-panel records that should never appear in the transcript:
      // they exist solely to update panel-level metadata (title, agentType).
      const rt = event.payload.record_type;
      if (rt === 'subagent-meta' || rt === 'custom-title' || rt === 'agent-name') continue;
      items.push({ type: 'meta', event });
    }
  }

  return {
    items: coalesceBetweenChats(coalesceFileOps(items)),
    checklist,
    pending,
  };
}

/**
 * Compress runs of non-bubble items between two bubbles into a single
 * `op-strip` row, so a long Bash/Edit/Read flurry between user/assistant
 * turns reads as one line. Singletons pass through unchanged.
 *
 * Inputs are post-file-coalescing, so a "run" may include `file-change`
 * items alongside plain tool capsules.
 */
export function coalesceBetweenChats(items: ViewItem[]): ViewItem[] {
  const out: ViewItem[] = [];
  let run: ViewItem[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(...run);
    } else {
      const first = run[0];
      const last = run[run.length - 1];
      if (first && last) {
        out.push({
          type: 'op-strip',
          anchorUuid: anchorOf(first),
          items: run.slice(),
          ts: anchorTs(last),
        });
      }
    }
    run = [];
  };

  for (const item of items) {
    if (item.type === 'bubble') {
      flush();
      out.push(item);
      continue;
    }
    // Any pending (un-resulted) tool keeps its own line so the loading
    // state stays visible to the user.
    if (item.type === 'tool' && item.result === null) {
      flush();
      out.push(item);
      continue;
    }
    run.push(item);
  }
  flush();
  return out;
}

function anchorOf(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.anchorUuid;
  }
  if (item.type === 'bubble') return item.event.uuid;
  return item.event.uuid;
}

function anchorTs(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.ts;
  }
  if (item.type === 'bubble') return item.event.ts;
  return item.event.ts;
}

/**
 * Collapse consecutive Read/Edit/Write/MultiEdit ops on the same file into
 * a single `file-change` item, as long as no chat (bubble) breaks the run.
 *
 * The run is broken by:
 *   - a `bubble` item (user message or substantive assistant message)
 *   - any non-file tool (Bash, Grep, …) targeting something else
 *   - a tool whose file_path differs from the run's current path
 *   - a tool with no `result` yet (we keep pending ops un-coalesced so
 *     their loading state stays visible)
 *
 * A run of length 1 stays as a plain tool item; we only collapse when ≥2.
 */
export function coalesceFileOps(items: ViewItem[]): ViewItem[] {
  const out: ViewItem[] = [];
  let run: ToolItem[] = [];
  let runPath: string | null = null;

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1 || runPath === null) {
      out.push(...run);
    } else {
      const first = run[0];
      const last = run[run.length - 1];
      if (first && last) {
        out.push({
          type: 'file-change',
          anchorUuid: first.anchorUuid,
          path: runPath,
          ops: run.slice(),
          ts: last.ts,
        });
      }
    }
    run = [];
    runPath = null;
  };

  for (const item of items) {
    if (item.type === 'tool') {
      const path = filePathOf(item);
      const canRun = path !== null && item.use !== null && item.result !== null;
      if (canRun && (runPath === null || runPath === path)) {
        run.push(item);
        runPath = path;
        continue;
      }
      flush();
      if (canRun) {
        run.push(item);
        runPath = path;
        continue;
      }
      out.push(item);
      continue;
    }
    if (item.type === 'bubble') {
      flush();
      out.push(item);
      continue;
    }
    // thinking / system / meta don't break a run (they're sidebar-y) but they
    // don't extend it either; pass them through in place.
    out.push(item);
  }
  flush();
  return out;
}

function filePathOf(item: ToolItem): string | null {
  if (!item.use || !FILE_TOOLS.has(item.use.name)) return null;
  const input = item.use.input as { file_path?: unknown };
  if (typeof input?.file_path !== 'string' || !input.file_path) return null;
  return input.file_path;
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

/** Walk backwards from the end of `items` and stamp `canceled: true` on
 * everything until the most recent user bubble (exclusive). Operates in
 * place. Stops at a previous interrupt boundary too, so two cancellations
 * in a row don't cascade past the older one. */
function markCanceledTurn(items: ViewItem[]): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type === 'bubble' && item.role === 'user') return;
    if (item.type === 'bubble' && item.canceled) return;
    if (
      item.type === 'bubble' ||
      item.type === 'tool' ||
      item.type === 'thinking'
    ) {
      item.canceled = true;
    }
  }
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
