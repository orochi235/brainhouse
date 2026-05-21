/**
 * Shared types for the event → view-item pipeline. Extracted from
 * `pipeline.ts` so per-transform modules under `../transforms/builtIn/`
 * can import them without pulling in the runner (and to avoid a
 * `pipeline.ts` ↔ `transforms/` circular import).
 *
 * Adding a new view-item shape? Define it here, then write a transform
 * under `../transforms/builtIn/` that emits it.
 */

import type { Event } from '@server/parser.ts';
import type { ToolResultPayload, ToolUsePayload } from './tools.ts';

export type BubblePart = { kind: 'text'; text: string } | { kind: 'sawtooth' };

export interface ToolItem {
  type: 'tool';
  anchorUuid: string;
  use: ToolUsePayload | null;
  result: ToolResultPayload | null;
  ack: string | null;
  ts: string;
  /** True when the user pressed ctrl-c mid-turn and this tool's call was
   * part of the canceled work. Rendered dimmed. */
  canceled?: boolean;
}

export interface FileChangeItem {
  type: 'file-change';
  /** First op's uuid — used as the React key + lightbox anchor. */
  anchorUuid: string;
  path: string;
  /** Original tool ops in order. Each is a fully-resolved use+result pair. */
  ops: ToolItem[];
  /** Latest op's timestamp. Used for the row's time gutter + idle ordering. */
  ts: string;
}

/** Runs of non-bubble items between two bubbles compress into this. */
export interface OpStripItem {
  type: 'op-strip';
  anchorUuid: string;
  items: ViewItem[];
  ts: string;
}

export interface BubbleItem {
  type: 'bubble';
  event: Event;
  role: 'user' | 'assistant';
  parts: BubblePart[];
  canceled?: boolean;
}

export type ViewItem =
  | BubbleItem
  | ToolItem
  | FileChangeItem
  | OpStripItem
  | { type: 'thinking'; event: Event; canceled?: boolean }
  | { type: 'system'; event: Event }
  | { type: 'meta'; event: Event };

/** Tool names whose inputs touch a single file via `input.file_path`. These
 * are the ops eligible for `coalesceFileOps()`. */
export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

export interface ChecklistItem {
  done: boolean;
  text: string;
}

export interface PreprocessResult {
  items: ViewItem[];
  /** The most recent ```brainhouse-checklist block found in any bubble. */
  checklist: ChecklistItem[] | null;
  /** True if the panel is currently awaiting Claude's reply (user → no asst yet). */
  pending: boolean;
}
