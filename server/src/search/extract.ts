import { type Event, hasTag } from '../parser.js';

/** One searchable row: the text of one event, plus what the filters need. */
export interface Doc {
  event_uuid: string;
  ts: string;
  kind: 'user_text' | 'assistant_text' | 'thinking' | 'tool_use' | 'tool_result';
  /** Tool name on tool_use; on tool_result, the matching tool_use's name. */
  tool: string | null;
  /** tool_use only: lets a later tool_result find its tool name. */
  tool_use_id: string | null;
  is_error: boolean;
  text: string;
}

/** Tool output content: a string, or an array of blocks of which only the
 * text blocks are kept (images are never indexed). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/** Tool input as text: every string or number value, depth first, keys
 * dropped. `{command: "ls -la", description: "List"}` → "ls -la\nList". */
export function toolInputText(input: unknown): string {
  const parts: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) visit(x);
  };
  visit(input);
  return parts.join('\n');
}

/** The searchable doc for an event, or null when it carries nothing worth
 * searching. Sidechannel `meta` records (skill preludes, injected
 * scaffolding) are left out: they repeat across sessions and drown real
 * hits. */
export function eventToDoc(
  e: Event,
  toolNameFor: (toolUseId: string) => string | null,
): Doc | null {
  if (hasTag(e, 'meta')) return null;
  const base = { event_uuid: e.uuid, ts: e.ts, tool: null, tool_use_id: null, is_error: false };
  switch (e.kind) {
    case 'user_text':
    case 'assistant_text':
    case 'thinking':
      return e.payload.text ? { ...base, kind: e.kind, text: e.payload.text } : null;
    case 'tool_use': {
      const input = toolInputText(e.payload.input);
      return {
        ...base,
        kind: 'tool_use',
        tool: e.payload.name || null,
        tool_use_id: e.payload.tool_use_id || null,
        text: input ? `${e.payload.name}\n${input}` : e.payload.name,
      };
    }
    case 'tool_result': {
      const text = toolResultText(e.payload.content);
      if (!text) return null;
      return {
        ...base,
        kind: 'tool_result',
        tool: toolNameFor(e.payload.tool_use_id),
        is_error: e.payload.is_error,
        text,
      };
    }
    default:
      return null;
  }
}
