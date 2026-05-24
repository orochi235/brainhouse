/**
 * Translates Claude Code's native `TodoWrite` tool calls into the panel's
 * pinned checklist. The most recent call wins — same precedence model as
 * `scanChecklist` (which reads ```brainhouse-checklist code blocks).
 *
 * Consumes the event so we don't also emit a tool capsule for it: TodoWrite
 * fires repeatedly during a turn and would otherwise spam the panel body.
 * The full todo list is already surfaced in the pinned header.
 */

import type { ChecklistItem } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

interface TodoInput {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

export const todoWriteToChecklist: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.todo-write-to-checklist',
  name: 'TodoWrite → checklist',
  description:
    "Routes Claude Code's TodoWrite tool calls into the panel's pinned checklist and suppresses the tool capsule.",
  run(event, _items, ctx) {
    if (event.kind !== 'tool_use') return false;
    if (event.payload.name !== 'TodoWrite') return false;
    const items = extractTodos(event.payload.input);
    if (items) ctx.scratch.checklist = items;
    return true;
  },
};

export function extractTodos(input: unknown): ChecklistItem[] | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const items: ChecklistItem[] = [];
  for (const t of raw as TodoInput[]) {
    if (!t || typeof t !== 'object') continue;
    const text =
      typeof t.content === 'string' && t.content.trim().length > 0 ? t.content.trim() : null;
    if (!text) continue;
    const status = typeof t.status === 'string' ? t.status : '';
    items.push({
      text,
      done: status === 'completed',
      inProgress: status === 'in_progress',
    });
  }
  return items.length > 0 ? items : null;
}
