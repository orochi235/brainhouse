/**
 * Renders an AskUserQuestion tool_use as a synthetic assistant bubble (Claude
 * is "speaking" the question + options) instead of a tool capsule. Marks the
 * tool_use_id as absorbed so the matching tool_result gets swallowed by
 * `mergeToolResult` rather than rendering an orphan capsule.
 *
 * When the matching tool_result is available, the answer is emitted as a
 * *separate* synthetic user-side bubble immediately after the assistant
 * bubble — so the exchange visually mirrors a real chat (Claude asks, you
 * reply). Multi-select answers ride along naturally — the answer string
 * carries the joined labels.
 *
 * Falls through (returns false) for other tool names; the default
 * `toolUseToCapsule` transform handles them.
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';

type AnswerInfo =
  | { kind: 'answered'; answers: Record<string, string> }
  | { kind: 'rejected' };

export const askUserQuestion: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.ask-user-question',
  name: 'AskUserQuestion → assistant bubble',
  description:
    'Renders an AskUserQuestion tool call as if Claude is speaking — bolded question + bulleted options. The matching tool_result is swallowed; the answer is emitted as a separate user-side bubble after the assistant bubble.',
  run(event, items, ctx) {
    if (event.kind !== 'tool_use' || event.payload.name !== 'AskUserQuestion') return false;
    const input = event.payload.input;
    const toolUseId = event.payload.tool_use_id;
    const answerInfo = toolUseId ? findAnswerInfo(ctx.allEvents, toolUseId) : null;
    const text = formatAskUserQuestion(input);
    if (!text) return false;
    items.push({
      type: 'bubble',
      event: { ...event, kind: 'assistant_text', payload: { text } } as Event,
      role: 'assistant',
      parts: [{ kind: 'text', text }],
    });
    const answerText = formatAskUserAnswer(input, answerInfo);
    if (answerText) {
      items.push({
        type: 'bubble',
        event: {
          ...event,
          uuid: `${event.uuid}:answer`,
          kind: 'user_text',
          payload: { text: answerText },
        } as Event,
        role: 'user',
        parts: [{ kind: 'text', text: answerText }],
      });
    }
    if (toolUseId) ctx.scratch.absorbedToolUseIds.add(toolUseId);
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

/** Build the user-side reply bubble that pairs with an AskUserQuestion.
 * Single question → the chosen labels alone. Multiple questions →
 * `Question → answer` per line. `null` when there's no answer to render. */
export function formatAskUserAnswer(input: unknown, info: AnswerInfo | null): string | null {
  if (!info) return null;
  if (info.kind === 'rejected') return '_(no answer)_';
  if (!input || typeof input !== 'object') return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const lines: string[] = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const question = (q as { question?: unknown }).question;
    if (typeof question !== 'string') continue;
    const raw = info.answers[question];
    if (!raw) continue;
    const labels = raw
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.length === 0) continue;
    const joined = labels.join(', ');
    lines.push(questions.length === 1 ? joined : `${question} → ${joined}`);
  }
  return lines.length > 0 ? lines.join('\n\n') : null;
}

function findAnswerInfo(events: readonly Event[], toolUseId: string): AnswerInfo | null {
  for (const e of events) {
    if (e.kind !== 'tool_result') continue;
    if (e.payload.tool_use_id !== toolUseId) continue;
    if (e.payload.is_error) return { kind: 'rejected' };
    const answers = extractAnswers(e.payload.content);
    if (answers) return { kind: 'answered', answers };
    return null;
  }
  return null;
}

/** Pulls the {question: label} map out of a tool_result content payload. */
function extractAnswers(content: unknown): Record<string, string> | null {
  // Structured form (e.g. test fixtures): { answers: { ... } }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const a = (content as { answers?: unknown }).answers;
    if (a && typeof a === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      if (Object.keys(out).length > 0) return out;
    }
  }
  // Real Claude Code form: a string like
  //   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now…`
  const str = typeof content === 'string' ? content : null;
  if (!str) return null;
  const out: Record<string, string> = {};
  const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
  while ((m = re.exec(str)) !== null) {
    const q = m[1]?.replace(/\\(.)/g, '$1');
    const a = m[2]?.replace(/\\(.)/g, '$1');
    if (q && a) out[q] = a;
  }
  return Object.keys(out).length > 0 ? out : null;
}
