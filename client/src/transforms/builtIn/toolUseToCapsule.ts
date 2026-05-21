/**
 * Default tool_use handler: emits a `tool` view item. Also handles the
 * orphan-upgrade case — if a result-only capsule was already rendered for
 * this tool_use_id (because tool_result arrived first), we upgrade it in
 * place instead of emitting a duplicate.
 *
 * Runs after `askUserQuestion`, so AskUserQuestion calls never reach here.
 */

import type { Stage1Transform } from '../types.ts';
import { findToolItem } from './util.ts';

export const toolUseToCapsule: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.tool-use-to-capsule',
  name: 'tool_use → new capsule',
  description:
    'Default tool_use handler: emits a `tool` view item. Special-cases the orphan-upgrade path when we already rendered a result-only capsule.',
  run(event, items) {
    if (event.kind !== 'tool_use') return false;
    const id = event.payload.tool_use_id;
    const orphan = id ? findToolItem(items, id) : null;
    if (orphan && !orphan.use) {
      orphan.use = event.payload;
      return true;
    }
    items.push({
      type: 'tool',
      anchorUuid: event.uuid,
      use: event.payload,
      result: null,
      ack: null,
      ts: event.ts,
    });
    return true;
  },
};
