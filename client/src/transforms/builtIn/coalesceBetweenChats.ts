/**
 * Compress runs of ≥2 non-bubble items (tool capsules, file-changes,
 * thinking, system, meta) between two bubbles into a single `op-strip`
 * row. Singletons pass through unchanged, and any pending (un-resulted)
 * tool keeps its own line so its loading state stays visible.
 *
 * Runs after `coalesceFileOps`, so a "run" may include file-change
 * items as well as plain tool capsules.
 */

import type { ViewItem } from '../../lib/pipeline-types.ts';
import type { Stage2Transform } from '../types.ts';

export const coalesceBetweenChats: Stage2Transform = {
  kind: 'view',
  stage: 2,
  key: 'built-in.coalesce-between-chats',
  name: 'coalesceBetweenChats',
  description:
    'A run of ≥2 non-bubble items (tool calls, file-changes, thinking) between two bubbles compresses into an `op-strip` row; click expands the lightbox.',
  run(items) {
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
      if (item.type === 'tool' && item.result === null) {
        flush();
        out.push(item);
        continue;
      }
      run.push(item);
    }
    flush();
    return out;
  },
};

function anchorOf(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.anchorUuid;
  }
  if (item.type === 'bubble') return item.event.uuid;
  if (item.type === 'interrupt-divider' || item.type === 'day-divider') return item.anchorUuid;
  return item.event.uuid;
}

function anchorTs(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.ts;
  }
  if (item.type === 'bubble') return item.event.ts;
  if (item.type === 'interrupt-divider' || item.type === 'day-divider') return item.ts;
  return item.event.ts;
}
