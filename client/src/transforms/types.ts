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
import type { ChecklistItem, ReplyTo, SubagentSpawn, ViewItem } from '../lib/pipeline-types.ts';

export interface ViewPipelineScratch {
  /** Tool_use ids whose result we've already absorbed elsewhere (e.g. an
   * AskUserQuestion that became a bubble). When the matching tool_result
   * arrives, transforms swallow it instead of rendering an orphan capsule. */
  absorbedToolUseIds: Set<string>;
  /** True if the panel is currently waiting on Claude (user spoke last). */
  pending: boolean;
  /** Most recent ```brainhouse-checklist block found in any bubble. */
  checklist: ChecklistItem[] | null;
  /** Subagents the panel has spawned via `Task` tool_use, in event order.
   * Populated by `taskSubagents`. */
  subagentSpawns: SubagentSpawn[];
  /** Trimmed text of `/btw` prompts seen in queue-operation meta records
   * that haven't been matched to a later user_text yet. The first user_text
   * whose trimmed text matches is rendered as the queued prompt and the
   * entry is popped. */
  pendingBtw: string[];
  /** Descriptor for the next assistant bubble to consume when the turn was
   * triggered by a side channel (`/btw` or a `<task-notification>`). The
   * assistant_text bubble copies it into `replyTo` and clears it. Cleared on
   * a non-/btw user_text (a fresh top-line prompt ends the chain). */
  pendingReply: ReplyTo | null;
}

export interface ViewContext {
  /** Full event list. Some transforms (e.g. mergeInterruptedFollowup) need
   * to look back at the raw stream, not just the rendered items. */
  allEvents: readonly Event[];
  /** Shared mutable state across all stage-1 transforms in one pass. */
  scratch: ViewPipelineScratch;
}

/** Which view consumes a transform's output. Today: the conversation
 * flow (`PanelCard` body, lightboxes) and the timeline (`Timeline.tsx`).
 * Transforms omit `views` to opt into every view — that's the default
 * for stage-1 work that's universally desirable (bubble emission, tool
 * capsule assembly). Stage-2 transforms that reshape the rendered flow
 * (coalescing runs into op-strips, inserting day dividers) typically
 * pin to `['conversation']` so the timeline keeps raw per-event detail. */
export type ViewName = 'conversation' | 'timeline';

interface BaseTransform {
  key: string;
  name: string;
  description: string;
  /** Restrict this transform to the listed views. Omitted = runs in all
   * views. */
  views?: ViewName[];
  /** Selector keys from the SelectorDef registry. If present, the runner
   * skips this transform's `run` for events that match none of them.
   * Omitted = run on every event (current behavior preserved during the
   * selector-engine migration). Meaningless on stage-2 transforms. */
  matches?: string[];
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
