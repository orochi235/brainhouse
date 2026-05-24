/**
 * Catch-all for the simple event kinds — thinking, system, meta — that
 * map 1:1 to view items with no special handling beyond "wrap and push".
 *
 * `meta` has a small absorption rule: records whose `record_type` is one
 * of the panel-metadata flavors (subagent-meta, custom-title, agent-name)
 * are silently dropped here, because a server-side state transform will
 * have already pulled them into panel-level fields.
 */

import type { Stage1Transform } from '../types.ts';

const ABSORBED_META = new Set([
  'subagent-meta',
  'custom-title',
  'agent-name',
  // /btw side channel: `queue-operation` is consumed by `tagBtwUserText`
  // already, but listed here for defense-in-depth. `attachment` records
  // mirror the same prompt and would render as a noisy duplicate.
  'queue-operation',
  'attachment',
]);

export const defaultEventItem: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.default-event-item',
  name: 'thinking / system / meta items',
  description:
    'Wraps thinking, system, and meta events as view items. Drops meta records that exist only to update panel-level state (subagent-meta, custom-title, agent-name).',
  run(event, items) {
    if (event.kind === 'thinking') {
      items.push({ type: 'thinking', event });
      return true;
    }
    if (event.kind === 'system') {
      items.push({ type: 'system', event });
      return true;
    }
    if (event.kind === 'meta') {
      if (ABSORBED_META.has(event.payload.record_type ?? '')) return true;
      items.push({ type: 'meta', event });
      return true;
    }
    return false;
  },
};
