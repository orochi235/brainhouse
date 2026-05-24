/**
 * Normalizes raw transcript JSONL records into typed Event objects.
 *
 * Mirrors brainhouse/parser.py. Each Claude Code transcript line is one of a
 * handful of record shapes; some records (an assistant message with multiple
 * content blocks) fan out into multiple Events with unique uuids.
 */

export type EventKind =
  | 'user_text'
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'resource_usage'
  | 'system'
  | 'meta';

interface EventBase {
  session_id: string;
  agent_id: string | null;
  uuid: string;
  parent_uuid: string | null;
  ts: string;
  /** Original working directory of the Claude Code session, when present
   * on the record. Used to read per-project theme files (.hued). */
  cwd: string | null;
}

export type Event =
  | (EventBase & {
      kind: 'user_text';
      payload: {
        text: string;
        /** True when the record had `isMeta: true` — typically a synthetic
         * follow-up injected by Claude Code (e.g. a Skill's SKILL.md prelude
         * after a Skill tool_use). Lets transforms route these elsewhere
         * instead of rendering a giant user bubble. */
        is_meta?: boolean;
        /** When present, this user_text was produced by the named tool_use
         * (e.g. Skill prelude → the Skill tool_use_id). */
        source_tool_use_id?: string;
      };
    })
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
      kind: 'resource_usage';
      payload: {
        model: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      };
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
  // Most records carry a uuid. Side-channel metadata records
  // (`custom-title`, `last-prompt`, `ai-title`, `file-history-snapshot`,
  // `permission-mode`, …) don't — and SessionStore dedupes by uuid, so
  // multiple uuid-less records all collide on `''` and only the first one
  // ever lands. Synthesize a content-derived uuid in that case: identical
  // re-emissions still dedupe (Claude Code repeats `custom-title` every
  // turn), but a new title or a different record type flows through.
  const uuid = asString(raw.uuid) ?? synthesizeUuid(raw);
  const parentUuid = asString(raw.parentUuid) ?? null;
  const ts = asString(raw.timestamp) ?? '';
  const cwd = asString(raw.cwd) ?? null;
  const rtype = asString(raw.type);

  const base = (
    uuidSuffix: string,
  ): {
    session_id: string;
    agent_id: string | null;
    uuid: string;
    parent_uuid: string | null;
    ts: string;
    cwd: string | null;
  } => ({
    session_id: sid,
    agent_id: aid,
    uuid: uuid + uuidSuffix,
    parent_uuid: parentUuid,
    ts,
    cwd,
  });

  if (rtype === 'user' || rtype === 'assistant') {
    const msg = (raw.message as Raw | undefined) ?? {};
    const content = (msg as Raw).content;
    const isMeta = rtype === 'user' && raw.isMeta === true;
    const srcToolUseId = rtype === 'user' ? asString(raw.sourceToolUseID) : null;
    const userMetaExtras: { is_meta?: boolean; source_tool_use_id?: string } = {};
    if (isMeta) userMetaExtras.is_meta = true;
    if (srcToolUseId) userMetaExtras.source_tool_use_id = srcToolUseId;

    // Emit a resource_usage event for every assistant message that carries
    // a `usage` block. Comes through as a sibling event with a `:usage`
    // uuid suffix so SessionStore can accumulate per-panel totals without
    // bloating the assistant_text event.
    const usageEvent = rtype === 'assistant' ? extractUsage(msg, base(':usage')) : null;

    if (typeof content === 'string') {
      const kind = rtype === 'user' ? 'user_text' : 'assistant_text';
      const payload =
        kind === 'user_text' ? { text: content, ...userMetaExtras } : { text: content };
      const events: Event[] = [{ ...base(''), kind, payload } as Event];
      if (usageEvent) events.push(usageEvent);
      return events;
    }
    if (!Array.isArray(content)) return usageEvent ? [usageEvent] : [];

    const out: Event[] = [];
    content.forEach((block, i) => {
      if (!block || typeof block !== 'object') return;
      const b = block as Raw;
      const btype = asString(b.type);
      const sfx = `:${i}`;

      if (btype === 'text') {
        const kind = rtype === 'user' ? 'user_text' : 'assistant_text';
        const text = asString(b.text) ?? '';
        const payload = kind === 'user_text' ? { text, ...userMetaExtras } : { text };
        out.push({ ...base(sfx), kind, payload } as Event);
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
    if (usageEvent) out.push(usageEvent);
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

/** djb2 hash of a stably-stringified record. Used to fabricate a stable,
 * content-derived uuid for JSONL lines that don't carry one. */
function synthesizeUuid(raw: Raw): string {
  const rtype = asString(raw.type) ?? 'unknown';
  const s = JSON.stringify(raw) ?? '';
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `synth:${rtype}:${(h >>> 0).toString(36)}`;
}

function asNonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Pull the `usage` block off an assistant message and emit it as its own
 * Event. Returns null when the message has no usage (e.g. local debug
 * scenarios). */
function extractUsage(
  msg: Raw,
  baseEvent: {
    session_id: string;
    agent_id: string | null;
    uuid: string;
    parent_uuid: string | null;
    ts: string;
    cwd: string | null;
  },
): Event | null {
  const usage = (msg as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = asNonNegInt(u.input_tokens);
  const output = asNonNegInt(u.output_tokens);
  const cacheCreate = asNonNegInt(u.cache_creation_input_tokens);
  const cacheRead = asNonNegInt(u.cache_read_input_tokens);
  // If every counter is zero, skip — nothing to report. Real usage records
  // always have at least output_tokens populated.
  if (input + output + cacheCreate + cacheRead === 0) return null;
  return {
    ...baseEvent,
    kind: 'resource_usage',
    payload: {
      model: asString((msg as { model?: unknown }).model),
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
    },
  };
}
