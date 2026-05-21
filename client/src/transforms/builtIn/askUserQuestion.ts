/**
 * Renders an AskUserQuestion tool_use as a synthetic assistant bubble (Claude
 * is "speaking" the question + options) instead of a tool capsule. Marks the
 * tool_use_id as absorbed so the matching tool_result gets swallowed by
 * `mergeToolResult` rather than rendering an orphan capsule.
 *
 * Falls through (returns false) for other tool names; the default
 * `toolUseToCapsule` transform handles them.
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';

export const askUserQuestion: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.ask-user-question',
  name: 'AskUserQuestion → assistant bubble',
  description:
    'Renders an AskUserQuestion tool call as if Claude is speaking — bolded question + bulleted options. The matching tool_result is swallowed.',
  run(event, items, ctx) {
    if (event.kind !== 'tool_use' || event.payload.name !== 'AskUserQuestion') return false;
    const text = formatAskUserQuestion(event.payload.input);
    if (!text) return false;
    items.push({
      type: 'bubble',
      event: { ...event, kind: 'assistant_text', payload: { text } } as Event,
      role: 'assistant',
      parts: [{ kind: 'text', text }],
    });
    if (event.payload.tool_use_id) ctx.scratch.absorbedToolUseIds.add(event.payload.tool_use_id);
    return true;
  },
};

export function formatAskUserQuestion(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const blocks: string[] = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const question = (q as { question?: unknown }).question;
    const multiSelect = (q as { multiSelect?: unknown }).multiSelect === true;
    const options = (q as { options?: unknown }).options;
    if (typeof question !== 'string') continue;
    const lines: string[] = [];
    lines.push(`**${question}**${multiSelect ? '  _(pick any)_' : ''}`);
    if (Array.isArray(options)) {
      for (const o of options) {
        if (!o || typeof o !== 'object') continue;
        const label = (o as { label?: unknown }).label;
        const description = (o as { description?: unknown }).description;
        if (typeof label !== 'string') continue;
        const desc = typeof description === 'string' && description ? ` — ${description}` : '';
        lines.push(`- **${label}**${desc}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}
