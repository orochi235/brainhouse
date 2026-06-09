/**
 * Translates Claude Code's native todo-style tool calls into the panel's
 * pinned checklist. Recognized tools:
 *
 *   - `TodoWrite`  — flat list, no ids. Each call replaces the whole list.
 *
 *   - `TaskCreate` — per-task. Each call appends ONE item using `subject`
 *                    (or `description`) as the text. Claude Code assigns
 *                    sequential string ids ("1", "2", "3", …) per session.
 *                    We mirror that locally with a counter so subsequent
 *                    `TaskUpdate` calls can find their target.
 *
 *   - `TaskUpdate` — patches one task by `taskId`: updates `status`
 *                    (and `subject`/`content` when present). No-op when
 *                    the id is unknown.
 *
 * Consumes each event so we don't also emit a tool capsule: these fire
 * repeatedly during a turn and would otherwise spam the panel body. The
 * full list is already surfaced in the pinned header.
 */

import type { ChecklistItem } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

interface TodoListInput {
  todos?: unknown;
}

interface LegacyTodoEntry {
  id?: unknown;
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

interface TaskCreateInput {
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
}

interface TaskUpdateInput {
  taskId?: unknown;
  status?: unknown;
  subject?: unknown;
  content?: unknown;
}

export const todoWriteToChecklist: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.todo-write-to-checklist',
  name: 'TodoWrite / TaskCreate / TaskUpdate → checklist',
  description:
    "Routes Claude Code's TodoWrite, TaskCreate, and TaskUpdate tool calls into the panel's pinned checklist and suppresses the tool capsule.",
  matches: ['tool-use.todo-write', 'tool-use.task-create', 'tool-use.task-update'],
  run(event, _items, ctx) {
    if (event.kind !== 'tool_use') return false; // type narrowing
    const name = event.payload.name;
    const ts = event.ts || undefined;
    if (name === 'TodoWrite') {
      const incoming = extractTodos(event.payload.input);
      if (incoming) ctx.scratch.checklist = mergeCompletedAt(ctx.scratch.checklist, incoming, ts);
      // Suppress the tool capsule unconditionally — TodoWrite without a
      // valid list is still noise we don't want in the body.
      ctx.scratch.absorbedToolUseIds.add(event.payload.tool_use_id);
      return true;
    }
    if (name === 'TaskCreate') {
      appendTaskCreate(ctx.scratch, event.payload.input, ts);
      ctx.scratch.absorbedToolUseIds.add(event.payload.tool_use_id);
      return true;
    }
    if (name === 'TaskUpdate') {
      applyTaskUpdate(ctx.scratch, event.payload.input, ts);
      ctx.scratch.absorbedToolUseIds.add(event.payload.tool_use_id);
      return true;
    }
    return false;
  },
};

/** Legacy TodoWrite shape: a `todos` array of `{ content, status }`
 * objects. Replaces the entire list on each call. */
export function extractTodos(input: unknown): ChecklistItem[] | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as TodoListInput).todos;
  if (!Array.isArray(raw)) return null;
  const items: ChecklistItem[] = [];
  for (const t of raw as LegacyTodoEntry[]) {
    if (!t || typeof t !== 'object') continue;
    const text =
      typeof t.content === 'string' && t.content.trim().length > 0 ? t.content.trim() : null;
    if (!text) continue;
    const status = typeof t.status === 'string' ? t.status : '';
    const id = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id) : undefined;
    items.push({
      text,
      done: status === 'completed',
      inProgress: status === 'in_progress',
      ...(id !== undefined ? { id } : {}),
    });
  }
  return items.length > 0 ? items : null;
}

/** Per-task TaskCreate shape. Each call appends one item; Claude Code's
 * server assigns sequential string ids starting at "1" per session, and
 * we mirror that here so subsequent `TaskUpdate`s can find the row. */
function appendTaskCreate(
  scratch: { checklist: ChecklistItem[] | null },
  input: unknown,
  ts: string | undefined,
): void {
  if (!input || typeof input !== 'object') return;
  const obj = input as TaskCreateInput;
  // `subject` is the canonical title; older clients used `description`.
  // `activeForm` is the present-progressive label ("Adding params to…")
  // and we ignore it for the static checklist text.
  const subject = pickFirstString(obj.subject, obj.description);
  if (!subject) return;
  const next = (scratch.checklist ?? []).slice();
  // Sequential id matching Claude Code's "Task #N" convention. Counting
  // from current length + 1 means a `TaskCreate` mid-session lines up
  // with the server-assigned id, which is what `TaskUpdate.taskId`
  // references.
  const id = String(next.length + 1);
  next.push({
    text: subject,
    done: false,
    inProgress: false,
    id,
    ...(ts ? { firstSeenAt: ts } : {}),
  });
  scratch.checklist = next;
}

function applyTaskUpdate(
  scratch: { checklist: ChecklistItem[] | null },
  input: unknown,
  ts: string | undefined,
): void {
  if (!input || typeof input !== 'object') return;
  const patch = input as TaskUpdateInput;
  const taskId =
    typeof patch.taskId === 'string' || typeof patch.taskId === 'number'
      ? String(patch.taskId)
      : null;
  if (!taskId) return;
  const list = scratch.checklist;
  if (!list) return;
  const idx = list.findIndex((i) => i.id === taskId);
  if (idx < 0) return;
  const prev = list[idx];
  if (!prev) return;
  const status = typeof patch.status === 'string' ? patch.status : null;
  const text = pickFirstString(patch.subject, patch.content);
  const nextDone = status !== null ? status === 'completed' : prev.done;
  // Stamp completion on the first transition into `done`. If the item
  // was already done, preserve the original stamp — most recent edit
  // shouldn't overwrite the moment of completion.
  const completedAt = prev.completedAt ?? (nextDone && !prev.done && ts ? ts : undefined);
  // Backfill firstSeenAt if the row predates the field — first update we
  // see stamps it. Better than nothing for measuring elapsed time.
  const firstSeenAt = prev.firstSeenAt ?? ts;
  const next: ChecklistItem = {
    ...prev,
    ...(status !== null
      ? { done: nextDone, inProgress: status === 'in_progress' }
      : {}),
    ...(text !== null ? { text } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(firstSeenAt ? { firstSeenAt } : {}),
  };
  const copy = list.slice();
  copy[idx] = next;
  scratch.checklist = copy;
}

/** Carry forward `completedAt` from any prior item that matches the
 * incoming one by id (when present) or by text. Newly-completed items
 * (done in `incoming`, not done in prior) get stamped with the
 * triggering event's timestamp. */
function mergeCompletedAt(
  prior: ChecklistItem[] | null,
  incoming: ChecklistItem[],
  ts: string | undefined,
): ChecklistItem[] {
  const stamp = (i: ChecklistItem): ChecklistItem => {
    const completedAt = i.done && ts && !i.completedAt ? ts : i.completedAt;
    const firstSeenAt = i.firstSeenAt ?? ts;
    return {
      ...i,
      ...(completedAt ? { completedAt } : {}),
      ...(firstSeenAt ? { firstSeenAt } : {}),
    };
  };
  if (!prior || prior.length === 0) return incoming.map(stamp);
  return incoming.map((i) => {
    const prev =
      (i.id ? prior.find((p) => p.id === i.id) : null) ??
      prior.find((p) => p.text === i.text);
    if (!prev) return stamp(i);
    const completedAt = prev.completedAt ?? (i.done && !prev.done && ts ? ts : undefined);
    const firstSeenAt = prev.firstSeenAt ?? i.firstSeenAt ?? ts;
    return {
      ...i,
      ...(completedAt ? { completedAt } : {}),
      ...(firstSeenAt ? { firstSeenAt } : {}),
    };
  });
}

function pickFirstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}
