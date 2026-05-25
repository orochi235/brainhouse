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
  /** Long-form content injected as a synthetic user-meta message tied to
   * this tool_use (e.g. a Skill's SKILL.md prelude). Hidden from the panel
   * body — surfaced only in the tool lightbox. */
  prelude?: string;
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
  /** This assistant bubble responds to a `/btw` queued interjection. The
   * user bubble carrying the queued prompt itself renders normally; this
   * flag drives the "↩ btw" chip + accent on the reply so the response
   * (not the prompt) is what's marked. */
  btw?: boolean;
}

export type ViewItem =
  | BubbleItem
  | ToolItem
  | FileChangeItem
  | OpStripItem
  | { type: 'thinking'; event: Event; canceled?: boolean }
  | { type: 'system'; event: Event }
  | { type: 'meta'; event: Event }
  | { type: 'cleared'; event: Event }
  /** Horizontal "----- user interrupted -----" rule. Emitted between a
   * canceled assistant turn and a fresh follow-up user_text that arrived
   * long enough after the ctrl-c to be considered a new prompt (full
   * interrupt) rather than a queued continuation. */
  | { type: 'interrupt-divider'; ts: string; anchorUuid: string };

/** Tool names whose inputs touch a single file via `input.file_path`. These
 * are the ops eligible for `coalesceFileOps()`. */
export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

export interface ChecklistItem {
  done: boolean;
  text: string;
  /** TodoWrite-sourced item currently in_progress. Rendered with a
   * distinct glyph + accent (no strikethrough, not yet done). */
  inProgress?: boolean;
  /** TaskCreate-sourced item id — preserved so subsequent
   * `TaskUpdate` patches (which reference items by `taskId`) can find
   * the right row. Absent on TodoWrite / scanChecklist items, which
   * don't carry stable ids. */
  id?: string;
  /** ISO timestamp of the event that flipped this item to `done`.
   * Set when a `TaskUpdate` (or a TodoWrite full-list replace) first
   * marks the item completed; preserved across subsequent updates so
   * the displayed timestamp is the original completion moment, not
   * the most recent edit. */
  completedAt?: string;
  /** ISO timestamp of the event that first introduced this item — a
   * `TaskCreate`, or the TodoWrite write that first surfaced it. Used
   * to display per-item elapsed time. Preserved across edits. */
  firstSeenAt?: string;
}

/** One spawned subagent the parent panel saw via a `Task` tool_use.
 * Populated by the `taskSubagents` transform. Independent of TodoWrite;
 * a session can have both a todo checklist and a list of dispatched
 * subagents. The matching child panel (if any) is joined in the UI by
 * `(parent_panel_id, agent_type, task_description)`. */
export interface SubagentSpawn {
  toolUseId: string;
  /** The `description` field from the Task tool input. Stable — survives
   * auto-title rename on the child via the server-side `task_description`. */
  description: string;
  /** The `subagent_type` (Explore, general-purpose, Plan, …). */
  agentType: string | null;
  /** 'running' until the matching tool_result lands. 'done'/'failed'
   * after. 'canceled' if the parent turn was interrupted (the tool
   * capsule was marked canceled). */
  status: 'running' | 'done' | 'failed' | 'canceled';
  /** Event order index — keeps rows stable across re-renders. */
  order: number;
}

export interface PreprocessResult {
  items: ViewItem[];
  /** The most recent ```brainhouse-checklist block found in any bubble. */
  checklist: ChecklistItem[] | null;
  /** True if the panel is currently awaiting Claude's reply (user → no asst yet). */
  pending: boolean;
  /** Subagents this panel spawned via the `Task` tool, in event order.
   * Empty array when none. */
  subagentSpawns: SubagentSpawn[];
}
