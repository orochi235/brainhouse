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
  | 'image'
  | 'system'
  | 'meta';

/**
 * Stand-in for an `{ type: 'image', source: { type: 'base64', … } }` block.
 * Transcript records inline image bytes as base64 — 200KB apiece is typical
 * — which would otherwise ride the whole way into panel memory and every
 * delta broadcast. The parser swaps the blob for one of these; the server's
 * ingest path (`stashEventImages`) writes the bytes to a content-addressed
 * cache, stamps `sha256`, and drops `data`. Anything a client sees therefore
 * has `sha256` and no `data`.
 */
export interface ImageRef {
  type: 'brainhouse-image';
  media_type: string;
  /** Decoded size. Derived from the base64 length, so it survives stashing. */
  bytes: number;
  /** Absent when the bytes were never stashed (persistence disabled, cache
   * unwritable) — renderers should fall back to a placeholder. */
  sha256?: string;
  /** Base64 payload. Lives only between `parseLine` and `stashEventImages`. */
  data?: string;
}

/** Media types served with a real Content-Type; everything else falls back
 * to `.bin` / octet-stream. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** Cache file name (and URL segment under `/api/image/`) for a stashed ref.
 * Null while the bytes haven't reached the cache. */
export function imageFileName(ref: Pick<ImageRef, 'sha256' | 'media_type'>): string | null {
  if (!ref.sha256) return null;
  return `${ref.sha256}.${IMAGE_EXTENSIONS[ref.media_type] ?? 'bin'}`;
}

export function isImageRef(value: unknown): value is ImageRef {
  return !!value && typeof value === 'object' && (value as ImageRef).type === 'brainhouse-image';
}

/**
 * Additive classification tags computed once at parse time. Downstream
 * code should classify via tags rather than re-deriving from `kind` /
 * payload shape — the JSONL schema shifts upstream and centralizing the
 * classifier keeps that change isolated to this file.
 *
 *   dialogue       — strict: direct user↔agent text only. `user_text`
 *                    (without `artifact` / `meta`) + `assistant_text`.
 *                    Excludes `thinking` (agent's internal monologue),
 *                    tool calls, sidechannel records.
 *   tool           — `tool_use` or `tool_result`.
 *   thinking       — agent extended thinking (kind === 'thinking').
 *   artifact       — Claude Code slash-command scaffolding emitted as
 *                    user_text: `<local-command-caveat>`,
 *                    `<command-name>`, `<command-message>`,
 *                    `<command-args>`, `<local-command-stdout>`.
 *   slash_command  — user_text artifact that's specifically a
 *                    `<command-name>...</command-name>` record (the
 *                    "/clear", "/branch", etc. the user typed). Always
 *                    co-resident with `artifact`.
 *   meta           — sidechannel metadata: `kind === 'meta'`, OR a
 *                    `user_text` synthesized by Claude Code with
 *                    `is_meta: true` (e.g. Skill SKILL.md preludes).
 *                    Does NOT bump a done/mini panel back to live.
 *   system         — `kind === 'system'`.
 *   sidechain      — subagent transcript records (the raw JSONL had
 *                    `isSidechain: true`). Lifts the flag onto the
 *                    Event so transforms don't have to re-read it.
 *   usage          — `kind === 'resource_usage'`.
 */
export type Tag =
  | 'dialogue'
  | 'tool'
  | 'thinking'
  | 'artifact'
  | 'slash_command'
  | 'meta'
  | 'system'
  | 'sidechain'
  | 'usage';

interface EventBase {
  session_id: string;
  agent_id: string | null;
  uuid: string;
  parent_uuid: string | null;
  ts: string;
  /** Original working directory of the Claude Code session, when present
   * on the record. Used to read per-project theme files (.hued). */
  cwd: string | null;
  /** Classification tags. See `Tag` for the taxonomy. Always present;
   * empty array means "no classifier matched" (defensive — shouldn't
   * happen for valid records). */
  tags: Tag[];
}

/** Membership check — a tiny shim so call sites read as
 * `hasTag(event, 'meta')` instead of array `.includes`. Defensive
 * against missing `tags` (synthetic events constructed outside the
 * parser may not carry them yet); a missing tag array reads as "no
 * tags applied" rather than throwing. */
export function hasTag(event: { tags?: Tag[] }, tag: Tag): boolean {
  return Array.isArray(event.tags) && event.tags.includes(tag);
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
      kind: 'image';
      payload: {
        ref: ImageRef;
        /** The N in the sibling text block's `[Image #N]` placeholder. Taken
         * from the record's `imagePasteIds` when present, else 1-based
         * position among the record's image blocks. */
        paste_id: number;
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
  const isSidechain = raw.isSidechain === true;
  const base = (
    uuidSuffix: string,
  ): {
    session_id: string;
    agent_id: string | null;
    uuid: string;
    parent_uuid: string | null;
    ts: string;
    cwd: string | null;
    tags: Tag[];
  } => ({
    session_id: sid,
    agent_id: aid,
    uuid: uuid + uuidSuffix,
    parent_uuid: parentUuid,
    ts,
    cwd,
    tags: [],
  });

  // Tag the produced events in one shot before returning. Centralizing
  // here keeps the classifier in lockstep with parsing — no downstream
  // ad-hoc re-derivation.
  const out = parseLineInner(raw, sid, aid, base, ts, cwd);
  for (const ev of out) tagEvent(ev, isSidechain);
  return out;
}

const ARTIFACT_RE = /^<(local-command-(caveat|stdout)|command-(name|message|args))>/;
const SLASH_COMMAND_RE = /^<command-name>/;

function tagEvent(ev: Event, isSidechain: boolean): void {
  const tags = ev.tags;
  if (isSidechain) tags.push('sidechain');
  switch (ev.kind) {
    case 'user_text': {
      const text = ev.payload.text ?? '';
      const isMeta = ev.payload.is_meta === true;
      const isArtifact = ARTIFACT_RE.test(text);
      if (isArtifact) {
        tags.push('artifact');
        if (SLASH_COMMAND_RE.test(text)) tags.push('slash_command');
      }
      if (isMeta) tags.push('meta');
      // Strict dialogue: direct user-typed text only.
      if (!isArtifact && !isMeta) tags.push('dialogue');
      break;
    }
    case 'assistant_text':
      tags.push('dialogue');
      break;
    case 'thinking':
      tags.push('thinking');
      break;
    case 'tool_use':
    case 'tool_result':
      tags.push('tool');
      break;
    case 'image':
      tags.push('dialogue');
      break;
    case 'resource_usage':
      tags.push('usage');
      break;
    case 'system':
      tags.push('system');
      break;
    case 'meta':
      tags.push('meta');
      break;
  }
}

function parseLineInner(
  raw: Raw,
  sid: string,
  aid: string | null,
  base: (sfx: string) => {
    session_id: string;
    agent_id: string | null;
    uuid: string;
    parent_uuid: string | null;
    ts: string;
    cwd: string | null;
    tags: Tag[];
  },
  _ts: string,
  _cwd: string | null,
): Event[] {
  const rtype = asString(raw.type);

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

    const pasteIds = Array.isArray(raw.imagePasteIds) ? raw.imagePasteIds : [];
    let imageOrdinal = 0;

    const out: Event[] = [];
    content.forEach((block, i) => {
      if (!block || typeof block !== 'object') return;
      const b = block as Raw;
      const btype = asString(b.type);
      const sfx = `:${i}`;
      const imageRef = btype === 'image' ? imageRefFromBlock(b) : null;

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
            content: derefImageBlocks(b.content),
            is_error: Boolean(b.is_error),
          },
        });
      } else if (imageRef) {
        const ordinal = imageOrdinal++;
        const declared = pasteIds[ordinal];
        out.push({
          ...base(sfx),
          kind: 'image',
          payload: {
            ref: imageRef,
            paste_id: typeof declared === 'number' ? declared : ordinal + 1,
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

/** `{ type: 'image', source: { type: 'base64', … } }` → an ImageRef holding
 * the still-unstashed blob. Null for any other block shape (including
 * already-dereferenced blocks and hypothetical url sources), which routes
 * the block to the `meta` catch-all unchanged. */
function imageRefFromBlock(block: Raw): ImageRef | null {
  const source = block.source;
  if (!source || typeof source !== 'object') return null;
  const s = source as Raw;
  if (asString(s.type) !== 'base64') return null;
  const data = asString(s.data);
  if (!data) return null;
  return {
    type: 'brainhouse-image',
    media_type: asString(s.media_type) ?? 'application/octet-stream',
    bytes: base64ByteLength(data),
    data,
  };
}

/** Rewrite any base64 image blocks nested in a tool_result's content array
 * (browser screenshots, mostly) into ImageRefs, leaving everything else
 * untouched. Returns the input unchanged when there's nothing to swap, so
 * the common text-only result keeps its identity. */
function derefImageBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const b = block as Raw;
    if (asString(b.type) !== 'image') return block;
    const ref = imageRefFromBlock(b);
    if (!ref) return block;
    changed = true;
    return { ...b, source: ref };
  });
  return changed ? out : content;
}

/** Decoded length of a base64 string, without decoding it. */
function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length / 4) * 3 - padding);
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
    tags: Tag[];
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
