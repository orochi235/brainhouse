import type { Event } from '../../server/src/parser.ts';

/**
 * Coarse shape key for bucketing events that matched no selector.
 * tool_use → kind + tool name; text kinds → kind + first `<tag` marker
 * found (or empty); everything else → kind alone. Deliberately lossy:
 * the point is to group "the same new shape", not to be unique.
 */
export function clusterKey(e: Event): string {
  if (e.kind === 'tool_use') {
    const name = (e.payload as { name?: string }).name ?? '';
    return `tool_use|${name}`;
  }
  if (e.kind === 'user_text' || e.kind === 'assistant_text' || e.kind === 'thinking') {
    const text = (e.payload as { text?: string }).text ?? '';
    const m = text.match(/<[a-z][a-z0-9-]*/i);
    return `${e.kind}|${m ? m[0] : ''}`;
  }
  return `${e.kind}|`;
}
