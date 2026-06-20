/**
 * Drives the view-transform pipeline. Walks every event through each
 * stage-1 transform (first to return true consumes the event), then runs
 * stage-2 transforms over the assembled item list in order. Each
 * transform call is wrapped in try/catch so a buggy user transform can't
 * break a panel — errors get console.error'd and the transform is treated
 * as if it did nothing for that event/items pass.
 *
 * Stage-1 dispatch is gated by `matches`: when a transform declares one
 * or more named selectors, the runner resolves them via
 * `selectors/registry.ts` and skips its `run` for events that match none
 * of them. Transforms without `matches` keep the pre-selector behavior
 * (run on every event).
 *
 * Optional trace + toggle instrumentation. When `opts.trace` is omitted
 * the runner takes the fast path: no record objects allocated, no
 * mutation snapshot taken, no per-event accumulator. The `isEnabled`
 * predicate, when present, lets the runner skip transforms the user has
 * toggled off on this panel — checked before selector evaluation so it's
 * the cheapest reject.
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

/** One trace row per stage-2 transform per pass. */
export interface Stage2TraceRecord {
  transformKey: string;
  ran: boolean;
  mutatedItems: boolean;
  beforeLen: number;
  afterLen: number;
  error?: TransformError;
}

/** Accumulator the caller supplies when it wants a trace; the runner
 * pushes records into it as the pipeline runs. */
export interface TraceAccumulator {
  perEvent: TraceRecord[];
  stage2: Stage2TraceRecord[];
}

export interface RunViewPipelineOpts {
  /** Filter transforms to those that opt into this view (or are unspecified,
   * meaning "runs everywhere"). Omitted = no filter; every transform runs.
   * Used by `Timeline` to skip conversation-flow rewriting and by lightboxes
   * to pick a specific view. */
  view?: ViewName;
  /** When present, the runner pushes a per-event + per-stage-2 trace into
   * this accumulator. Omitted = fast path, zero trace allocation. */
  trace?: TraceAccumulator;
  /** Per-transform enable check (see `useTransformToggles`). Called once
   * per transform per event. Omitted = every transform enabled. */
  isEnabled?: (transformKey: string) => boolean;
}

/** Sentinel returned when a transform has no `matches` declared —
 * "matches everything" semantics. */
const ANY = 'any' as const;
type MatchHit = string | typeof ANY | null;

function firstSelectorHit(matches: string[] | undefined, event: Event): MatchHit {
  if (!matches || matches.length === 0) return ANY;
  for (const key of matches) {
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

function snapshotItems(items: ViewItem[]): { length: number; tailRef: ViewItem | null } {
  return {
    length: items.length,
    tailRef: items.length > 0 ? (items[items.length - 1] as ViewItem) : null,
  };
}
function detectMutation(
  before: { length: number; tailRef: ViewItem | null },
  items: ViewItem[],
): boolean {
  if (items.length !== before.length) return true;
  if (items.length === 0) return false;
  return items[items.length - 1] !== before.tailRef;
}

function toTransformError(err: unknown, transformKey: string, eventUuid?: string): TransformError {
  return {
    transformKey,
    message: err instanceof Error ? err.message : String(err),
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
      pendingReply: null,
      pendingReplyHolder: null,
    },
  };
  const stage1 = eligible.filter(isStage1);
  const stage2 = eligible.filter(isStage2);
  let items: ViewItem[] = [];
  const trace = opts.trace;
  const isEnabled = opts.isEnabled;

  for (const event of events) {
    const record: TraceRecord | null = trace
      ? { eventUuid: event.uuid, perStage: [], finalItemIndices: [] }
      : null;
    for (const t of stage1) {
      const enabled = isEnabled ? isEnabled(t.key) : true;
      const matchHit = firstSelectorHit(t.matches, event);
      const matched = matchHit !== null;
      if (!enabled) {
        record?.perStage.push({
          transformKey: t.key,
          matched,
          ran: false,
          consumed: false,
          mutatedItems: false,
        });
        continue;
      }
      if (!matched) {
        record?.perStage.push({
          transformKey: t.key,
          matched: false,
          ran: false,
          consumed: false,
          mutatedItems: false,
        });
        continue;
      }
      const before = record ? snapshotItems(items) : null;
      let consumed = false;
      let error: TransformError | undefined;
      try {
        consumed = t.run(event, items, ctx) === true;
      } catch (err) {
        error = toTransformError(err, t.key, event.uuid);
        console.error(`[transform ${t.key}] threw on event ${event.uuid}:`, err);
      }
      if (record && before) {
        record.perStage.push({
          transformKey: t.key,
          ...(matchHit === ANY ? {} : { selectorKey: matchHit }),
          matched: true,
          ran: true,
          consumed,
          mutatedItems: detectMutation(before, items),
          ...(error ? { error } : {}),
        });
      }
      if (consumed) break;
    }
    if (record && trace) trace.perEvent.push(record);
  }

  for (const t of stage2) {
    const enabled = isEnabled ? isEnabled(t.key) : true;
    const beforeLen = items.length;
    if (!enabled) {
      trace?.stage2.push({
        transformKey: t.key,
        ran: false,
        mutatedItems: false,
        beforeLen,
        afterLen: beforeLen,
      });
      continue;
    }
    let mutated = false;
    let error: TransformError | undefined;
    try {
      const next = t.run(items, ctx);
      mutated = next !== items || next.length !== beforeLen;
      items = next;
    } catch (err) {
      error = toTransformError(err, t.key);
      console.error(`[transform ${t.key}] threw in stage-2 pass:`, err);
    }
    trace?.stage2.push({
      transformKey: t.key,
      ran: true,
      mutatedItems: mutated,
      beforeLen,
      afterLen: items.length,
      ...(error ? { error } : {}),
    });
  }

  if (trace) {
    // Best-effort: attribute each final item back to the event whose
    // uuid surfaces as the item's anchorUuid or carrier `event.uuid`.
    // Stage-2 coalescing that drops/merges anchors is out of scope —
    // those records just get an empty finalItemIndices.
    const indexByUuid = new Map<string, number[]>();
    items.forEach((it, idx) => {
      const uuid =
        (it as { anchorUuid?: string }).anchorUuid ??
        (it as { event?: { uuid?: string } }).event?.uuid;
      if (!uuid) return;
      const arr = indexByUuid.get(uuid) ?? [];
      arr.push(idx);
      indexByUuid.set(uuid, arr);
    });
    for (const rec of trace.perEvent) {
      const idxs = indexByUuid.get(rec.eventUuid);
      if (idxs) rec.finalItemIndices = idxs;
    }
  }

  return {
    items,
    checklist: ctx.scratch.checklist,
    pending: ctx.scratch.pending,
    subagentSpawns: ctx.scratch.subagentSpawns,
  };
}
