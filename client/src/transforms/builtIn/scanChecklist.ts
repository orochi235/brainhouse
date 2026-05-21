/**
 * Scans every user/assistant text event for a ```pensieve-checklist code
 * block. The most recent one wins — surfaced as the panel's pinned
 * progress list in the header.
 *
 * Pass-through: never consumes the event.
 */

import type { ChecklistItem } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

export const scanChecklist: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.scan-checklist',
  name: 'checklist scan',
  description:
    "Finds the most recent ```pensieve-checklist code block in any bubble and surfaces it as the panel's pinned progress list.",
  run(event, _items, ctx) {
    if (
      (event.kind === 'user_text' || event.kind === 'assistant_text') &&
      typeof event.payload.text === 'string'
    ) {
      const found = extractLastChecklist(event.payload.text);
      if (found) ctx.scratch.checklist = found;
    }
  },
};

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
