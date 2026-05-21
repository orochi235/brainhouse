/**
 * View-transform contract. The client-side half of the schema described in
 * `docs/transforms-schema.md`: each transform is a single-responsibility unit
 * that contributes to the event → view-item pipeline. The registry composes
 * them; the runner applies them with per-transform error isolation.
 *
 * Stage 1 transforms run once per event, in registration order. The first
 * transform to return `true` from `run()` "consumes" the event — subsequent
 * stage-1 transforms don't see it. (This mirrors the original
 * `preprocessEvents` if/else chain where the first matching branch wins.)
 *
 * Stage 2 transforms run once over the assembled item list, in registration
 * order. Each returns a new list — they can replace, drop, or insert items.
 */

import type { Event } from '@server/parser.ts';
import type { ChecklistItem, ViewItem } from '../lib/pipeline-types.ts';

export interface ViewPipelineScratch {
  /** Tool_use ids whose result we've already absorbed elsewhere (e.g. an
   * AskUserQuestion that became a bubble). When the matching tool_result
   * arrives, transforms swallow it instead of rendering an orphan capsule. */
  absorbedToolUseIds: Set<string>;
  /** True if the panel is currently waiting on Claude (user spoke last). */
  pending: boolean;
  /** Most recent ```pensieve-checklist block found in any bubble. */
  checklist: ChecklistItem[] | null;
}

export interface ViewContext {
  /** Full event list. Some transforms (e.g. mergeInterruptedFollowup) need
   * to look back at the raw stream, not just the rendered items. */
  allEvents: readonly Event[];
  /** Shared mutable state across all stage-1 transforms in one pass. */
  scratch: ViewPipelineScratch;
}

interface BaseTransform {
  key: string;
  name: string;
  description: string;
}

export interface Stage1Transform extends BaseTransform {
  kind: 'view';
  stage: 1;
  /** Returns true to consume the event (skip remaining stage-1 transforms
   * for this event), false/undefined to pass through. May mutate `items`
   * in place — both by pushing new entries and by editing prior ones
   * (`foldToolAck` sets `last.ack`; `markCanceledTurn` stamps prior items).
   */
  run(event: Event, items: ViewItem[], ctx: ViewContext): boolean | void;
}

export interface Stage2Transform extends BaseTransform {
  kind: 'view';
  stage: 2;
  /** Returns a new item list. Pure with respect to `items` — must not
   * mutate the input array. */
  run(items: ViewItem[], ctx: ViewContext): ViewItem[];
}

export type ViewTransform = Stage1Transform | Stage2Transform;

/** Raised through the runner's catch block. Surfaced to the UI later;
 * for now console.error'd so devs see it. */
export interface TransformError {
  transformKey: string;
  message: string;
  eventUuid?: string;
  ts: number;
}
