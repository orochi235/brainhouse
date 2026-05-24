/**
 * Drives the view-transform pipeline. Walks every event through each
 * stage-1 transform (first to return true consumes the event), then runs
 * stage-2 transforms over the assembled item list in order. Each
 * transform call is wrapped in try/catch so a buggy user transform can't
 * break a panel — errors get console.error'd and the transform is treated
 * as if it did nothing for that event/items pass.
 */

import type { Event } from '@server/parser.ts';
import type { PreprocessResult, ViewItem } from '../lib/pipeline-types.ts';
import { VIEW_TRANSFORMS } from './registry.ts';
import type { Stage1Transform, Stage2Transform, ViewContext, ViewTransform } from './types.ts';

function isStage1(t: ViewTransform): t is Stage1Transform {
  return t.stage === 1;
}
function isStage2(t: ViewTransform): t is Stage2Transform {
  return t.stage === 2;
}

export function runViewPipeline(
  events: Event[],
  transforms: ViewTransform[] = VIEW_TRANSFORMS,
): PreprocessResult {
  const ctx: ViewContext = {
    allEvents: events,
    scratch: {
      absorbedToolUseIds: new Set(),
      pending: false,
      checklist: null,
      subagentSpawns: [],
      pendingBtw: [],
      pendingBtwAssistant: false,
    },
  };
  const stage1 = transforms.filter(isStage1);
  const stage2 = transforms.filter(isStage2);
  let items: ViewItem[] = [];

  for (const event of events) {
    for (const t of stage1) {
      let consumed = false;
      try {
        consumed = t.run(event, items, ctx) === true;
      } catch (err) {
        console.error(`[transform ${t.key}] threw on event ${event.uuid}:`, err);
      }
      if (consumed) break;
    }
  }

  for (const t of stage2) {
    try {
      items = t.run(items, ctx);
    } catch (err) {
      console.error(`[transform ${t.key}] threw in stage-2 pass:`, err);
    }
  }

  return {
    items,
    checklist: ctx.scratch.checklist,
    pending: ctx.scratch.pending,
    subagentSpawns: ctx.scratch.subagentSpawns,
  };
}
