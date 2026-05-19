/**
 * Normalizes raw transcript JSONL records into typed Event objects.
 *
 * Mirrors pensieve/parser.py. Each Claude Code transcript line is one of a
 * handful of record shapes; some records (an assistant message with multiple
 * content blocks) fan out into multiple Events with unique uuids.
 */

export type EventKind =
  | 'user_text'
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'meta';

interface EventBase {
  session_id: string;
  agent_id: string | null;
  uuid: string;
  parent_uuid: string | null;
  ts: string;
}

export type Event =
  | (EventBase & { kind: 'user_text'; payload: { text: string } })
  | (EventBase & { kind: 'assistant_text'; payload: { text: string } })
  | (EventBase & { kind: 'thinking'; payload: { text: string } })
  | (EventBase & {
      kind: 'tool_use';
      payload: { tool_use_id: string; name: string; input: unknown };
    })
  | (EventBase & {
      kind: 'tool_result';
      payload: { tool_use_id: string; content: unknown; is_error: boolean };
    })
  | (EventBase & {
      kind: 'system';
      payload: {
        subtype: string | null;
        content: string | null;
        level: string | null;
      };
    })
  | (EventBase & {
      kind: 'meta';
      payload: {
        record_type?: string;
        block_type?: string;
        raw: unknown;
      };
    });

/** Anything callers might hand us — JSON-parsed lines, raw objects, etc. */
export type Raw = Record<string, unknown>;

export interface ParseContext {
  session_id?: string | null;
  agent_id?: string | null;
}

export function parseLine(raw: Raw, ctx: ParseContext = {}): Event[] {
  const sid = asString(raw.sessionId) ?? ctx.session_id ?? '';
  const aid = asString(raw.agentId) ?? ctx.agent_id ?? null;
  const uuid = asString(raw.uuid) ?? '';
  const parentUuid = asString(raw.parentUuid) ?? null;
  const ts = asString(raw.timestamp) ?? '';
  const rtype = asString(raw.type);

  const base = (
    uuidSuffix: string,
  ): {
    session_id: string;
    agent_id: string | null;
    uuid: string;
    parent_uuid: string | null;
    ts: string;
  } => ({
    session_id: sid,
    agent_id: aid,
    uuid: uuid + uuidSuffix,
    parent_uuid: parentUuid,
    ts,
  });

  if (rtype === 'user' || rtype === 'assistant') {
    const msg = (raw.message as Raw | undefined) ?? {};
    const content = (msg as Raw).content;

    if (typeof content === 'string') {
      const kind = rtype === 'user' ? 'user_text' : 'assistant_text';
      return [{ ...base(''), kind, payload: { text: content } }];
    }
    if (!Array.isArray(content)) return [];

    const out: Event[] = [];
    content.forEach((block, i) => {
      if (!block || typeof block !== 'object') return;
      const b = block as Raw;
      const btype = asString(b.type);
      const sfx = `:${i}`;

      if (btype === 'text') {
        const kind = rtype === 'user' ? 'user_text' : 'assistant_text';
        out.push({ ...base(sfx), kind, payload: { text: asString(b.text) ?? '' } });
      } else if (btype === 'thinking') {
        out.push({
          ...base(sfx),
          kind: 'thinking',
          payload: { text: asString(b.thinking) ?? '' },
        });
      } else if (btype === 'tool_use') {
        out.push({
          ...base(sfx),
          kind: 'tool_use',
          payload: {
            tool_use_id: asString(b.id) ?? '',
            name: asString(b.name) ?? '',
            input: b.input ?? {},
          },
        });
      } else if (btype === 'tool_result') {
        out.push({
          ...base(sfx),
          kind: 'tool_result',
          payload: {
            tool_use_id: asString(b.tool_use_id) ?? '',
            content: b.content,
            is_error: Boolean(b.is_error),
          },
        });
      } else {
        out.push({
          ...base(sfx),
          kind: 'meta',
          payload: { block_type: btype ?? undefined, raw: b },
        });
      }
    });
    return out;
  }

  if (rtype === 'system') {
    return [
      {
        ...base(''),
        kind: 'system',
        payload: {
          subtype: asString(raw.subtype) ?? null,
          content: asString(raw.content) ?? null,
          level: asString(raw.level) ?? null,
        },
      },
    ];
  }

  // Everything else: session-level metadata records (permission-mode,
  // agent-color, agent-name, custom-title, pr-link, queue-operation,
  // file-history-snapshot, attachment, last-prompt, ...). Pass through as
  // meta; the session store decides which ones matter for panel headers.
  return [
    {
      ...base(''),
      kind: 'meta',
      payload: { record_type: rtype ?? undefined, raw },
    },
  ];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
