/**
 * Drives the view-transform pipeline. Walks every event through each
 * stage-1 transform (first to return true consumes the event), then runs
 * stage-2 transforms over the assembled item list in order. Each
 * transform call is wrapped in try/catch so a buggy user transform can't
 * break a panel — errors get console.error'd and the transform is treated
 * as if it did nothing for that event/items pass.
 *
 * Stage-1 dispatch is gated by `matches`: when a transform declares one
 * or more named selectors, the runner skips its `run` for events that
 * match none of them. Selectors are resolved (and memoized) via
 * `selectors/registry.ts`. Transforms without `matches` keep the
 * pre-selector behavior (run on every event).
 *
 * When `opts.trace` is supplied, the runner appends one TraceRecord per
 * event with one perStage entry per stage-1 transform in registration
 * order. Spec 3 owns the finalItemIndices attribution + mutation
 * heuristic; Spec 1 only emits the per-stage skeleton.
 */

import type { Event } from '@server/parser.ts';
import type { PreprocessResult, ViewItem } from '../lib/pipeline-types.ts';
import { VIEW_TRANSFORMS } from './registry.ts';
import { resolveSelector } from './selectors/registry.ts';
import type { TraceRecord } from './selectors/types.ts';
import type {
  Stage1Transform,
  Stage2Transform,
  TransformError,
  ViewContext,
  ViewName,
  ViewTransform,
} from './types.ts';

function isStage1(t: ViewTransform): t is Stage1Transform {
  return t.stage === 1;
}
function isStage2(t: ViewTransform): t is Stage2Transform {
  return t.stage === 2;
}

export interface RunViewPipelineOpts {
  /** Filter transforms to those that opt into this view (or are unspecified,
   * meaning "runs everywhere"). Omitted = no filter; every transform runs.
   * Used by `Timeline` to skip conversation-flow rewriting and by lightboxes
   * to pick a specific view. */
  view?: ViewName;
  /** When supplied, the runner appends one TraceRecord per event with one
   * perStage entry per stage-1 transform. Spec 3 owns the surface that
   * consumes this; Spec 1 emits the skeleton. Omit for the fast path. */
  trace?: TraceRecord[];
}

/** Sentinel returned when a transform has no `matches` declared —
 * "matches everything" semantics. */
const ANY = 'any' as const;
type MatchHit = string | typeof ANY | null;

function firstSelectorHit(keys: string[], event: Event): string | null {
  for (const key of keys) {
    try {
      if (resolveSelector(key).match(event)) return key;
    } catch (err) {
      // Compile errors at first-use are real bugs; surface and continue
      // (returning null treats the transform as "no match" for this event).
      console.error(`[selector ${key}] threw during match:`, err);
    }
  }
  return null;
}

function toTransformError(err: unknown, transformKey: string, eventUuid?: string): TransformError {
  const message = err instanceof Error ? err.message : String(err);
  return {
    transformKey,
    message,
    ...(eventUuid ? { eventUuid } : {}),
    ts: Date.now(),
  };
}

export function runViewPipeline(
  events: Event[],
  opts: RunViewPipelineOpts = {},
  transforms: ViewTransform[] = VIEW_TRANSFORMS,
): PreprocessResult {
  const view = opts.view;
  const eligible = view
    ? transforms.filter((t) => !t.views || t.views.includes(view))
    : transforms;
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
  const stage1 = eligible.filter(isStage1);
  const stage2 = eligible.filter(isStage2);
  let items: ViewItem[] = [];
  const trace = opts.trace;

  for (const event of events) {
    const record: TraceRecord | undefined = trace
      ? { eventUuid: event.uuid, perStage: [], finalItemIndices: [] }
      : undefined;
    for (const t of stage1) {
      const matchHit: MatchHit = t.matches ? firstSelectorHit(t.matches, event) : ANY;
      if (matchHit === null) {
        record?.perStage.push({
          transformKey: t.key,
          matched: false,
          ran: false,
          consumed: false,
          mutatedItems: false,
        });
        continue;
      }
      let consumed = false;
      let error: TransformError | undefined;
      try {
        consumed = t.run(event, items, ctx) === true;
      } catch (err) {
        error = toTransformError(err, t.key, event.uuid);
        console.error(`[transform ${t.key}] threw on event ${event.uuid}:`, err);
      }
      record?.perStage.push({
        transformKey: t.key,
        ...(matchHit === ANY ? {} : { selectorKey: matchHit }),
        matched: true,
        ran: true,
        consumed,
        mutatedItems: false,
        ...(error ? { error } : {}),
      });
      if (consumed) break;
    }
    if (record) trace?.push(record);
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
