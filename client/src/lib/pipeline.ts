/**
 * Public entry point to the event → view-item pipeline.
 *
 * The actual transforms live one folder over, under
 * `../transforms/builtIn/`; the registry that composes them is in
 * `../transforms/registry.ts`, and the runner that applies them is in
 * `../transforms/runner.ts`. This file exists to (a) keep
 * `preprocessEvents` importable from its long-standing location, and (b)
 * re-export the view-item types so consumer components don't need to
 * know about the transforms folder layout.
 */

import type { Event } from '@server/parser.ts';
import { extractLastChecklist } from '../transforms/builtIn/scanChecklist.ts';
import { runViewPipeline, type TraceAccumulator } from '../transforms/runner.ts';
import type { ViewName } from '../transforms/types.ts';
import type { PreprocessResult } from './pipeline-types.ts';

export type {
  BubbleItem,
  BubblePart,
  ChecklistItem,
  FileChangeItem,
  OpStripItem,
  PreprocessResult,
  ToolItem,
  ViewItem,
} from './pipeline-types.ts';
export { FILE_TOOLS } from './pipeline-types.ts';
export { extractLastChecklist };
export type { ViewName };

export interface PreprocessOpts {
  /** Restrict the transform set to those that opt into the named view.
   * Omitted = run every transform (legacy callers + non-view-aware
   * consumers like the subagent progress scanner). */
  view?: ViewName;
  /** Opt-in pipeline trace. Omitted = zero-allocation fast path
   * (existing behavior). See `runner.ts` for the accumulator shape. */
  trace?: TraceAccumulator;
  /** Per-transform enable check. Omitted = every transform enabled.
   * Wired by the inspector's per-panel toggle hook. */
  isEnabled?: (transformKey: string) => boolean;
}

export function preprocessEvents(
  events: Event[],
  opts: PreprocessOpts = {},
): PreprocessResult {
  return runViewPipeline(events, opts);
}
