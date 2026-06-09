/**
 * Attaches a `tool_result` event onto the matching tool capsule (by
 * tool_use_id). Three outcomes:
 *
 *   1. The use was absorbed elsewhere (e.g. an AskUserQuestion → bubble) →
 *      swallow the result; nothing to attach to.
 *   2. Found a prior tool capsule with this id → set `.result` on it.
 *   3. No matching use yet (result arrived before use, or out-of-order
 *      JSONL) → render an orphan capsule (result-only). A later tool_use
 *      with the same id will upgrade it via `toolUseToCapsule`.
 */

import type { Stage1Transform } from '../types.ts';
import { findToolItem } from './util.ts';

export const mergeToolResult: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.merge-tool-result',
  name: 'mergeToolResultIntoCapsule',
  description:
    'Attaches a tool_result onto the existing tool capsule with the same tool_use_id. Orphans (result with no use) render as a result-only capsule.',
  matches: ['tool-result.any'],
  run(event, items, ctx) {
    if (event.kind !== 'tool_result') return false; // type narrowing
    const id = event.payload.tool_use_id;
    if (id && ctx.scratch.absorbedToolUseIds.has(id)) return true;
    const target = id ? findToolItem(items, id) : null;
    if (target) {
      target.result = event.payload;
      target.resultTs = event.ts;
      return true;
    }
    items.push({
      type: 'tool',
      anchorUuid: event.uuid,
      use: null,
      result: event.payload,
      resultTs: event.ts,
      ack: null,
      ts: event.ts,
    });
    return true;
  },
};
