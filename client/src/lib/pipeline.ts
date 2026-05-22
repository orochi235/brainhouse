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
import { runViewPipeline } from '../transforms/runner.ts';
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

export function preprocessEvents(events: Event[]): PreprocessResult {
  return runViewPipeline(events);
}
