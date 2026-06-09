/**
 * Draft-selector inference for the point-and-build authoring path. Walks
 * the event's `kind` + `payload` shape and emits a `event[kind=…] > …`
 * source string the engine can parse. v1 keeps the grammar minimal — the
 * user gets a head start, not a finished selector.
 */

import type { Event } from '@server/parser.ts';

const TEXT_MARKERS = ['bash-input', 'bh-title', 'task-notification', 'brainhouse-checklist'];

export function infer(e: Event): string {
  const parts = [`event[kind=${e.kind}]`];
  const payload = (e as { payload?: Record<string, unknown> }).payload ?? {};
  switch (e.kind) {
    case 'tool_use': {
      const name = (payload as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) {
        parts.push(`tool_use[name=${name}]`);
      }
      break;
    }
    case 'tool_result': {
      if ((payload as { tool_use_id?: unknown }).tool_use_id) {
        parts.push('tool_result');
      }
      break;
    }
    case 'user_text':
    case 'assistant_text': {
      const text = (payload as { text?: unknown }).text;
      if (typeof text === 'string') {
        for (const tag of TEXT_MARKERS) {
          if (text.includes(`<${tag}`)) {
            parts.push(`text[contains=<${tag}]`);
            break;
          }
        }
      }
      break;
    }
    case 'meta': {
      const metaKind = (payload as { kind?: unknown }).kind;
      if (typeof metaKind === 'string' && metaKind.length > 0) {
        parts.push(`meta[kind=${metaKind}]`);
      }
      break;
    }
  }
  return parts.join(' > ');
}
