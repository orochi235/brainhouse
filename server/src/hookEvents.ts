/**
 * Sidecar watcher for Claude Code hook events.
 *
 * The hook dispatcher (hooks/dispatcher.mjs) appends one JSON line per hook
 * invocation to `<eventsDir>/<session_id>.jsonl`. This watcher tails those
 * files, parses each new line, and hands the parsed event to a callback —
 * the monitor turns it into lifecycle deltas (forceStatus, setAwaiting).
 *
 * Design mirrors the transcript watcher: chokidar + per-file byte offsets,
 * so a restart picks up unread lines instead of re-replaying everything.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { type Watcher, startWatcher } from './watchBackend.js';

export const HookEventSchema = z.object({
  kind: z.enum([
    'stop',
    'subagent_stop',
    'subagent_start',
    'notification',
    'session_end',
    'session_start',
    'auto_title',
    'hook_overhead',
    'session_pid',
    'bash_intent',
    'bash_id_map',
  ]),
  session_id: z.string().min(1),
  /** Absolute path of the transcript that triggered the hook, if Claude
   * Code provided one. Used by session_start to locate the prior panel
   * (same encoded-cwd directory) that should be superseded. */
  transcript_path: z.string().optional(),
  /** Short human-readable reason from Notification ("permission required",
   * "input requested"). Unused today; carried through for the UI. */
  message: z.string().optional(),
  /** SessionStart only. ∈ {startup, resume, clear, compact}. Brainhouse
   * only acts on clear/compact — startup/resume don't supersede a prior
   * panel. Other values pass through but are ignored. */
  source: z.string().optional(),
  /** auto_title only. The proposed new panel title. Server validates and
   * applies if it differs from the current title. */
  title: z.string().optional(),
  /** subagent_start only. The Task tool's `subagent_type` input. */
  subagent_type: z.string().optional(),
  /** subagent_start only. The Task tool's short `description` input. */
  description: z.string().optional(),
  /** hook_overhead only. Which brainhouse hook injected context. */
  hook_name: z.string().optional(),
  /** hook_overhead only. Estimated tokens added to the next turn's
   * context by this hook's output (chars/4 proxy). */
  tokens: z.number().optional(),
  /** session_pid only. PID of the Claude Code process. */
  pid: z.number().optional(),
  /** session_pid only. Parent PID. */
  ppid: z.number().optional(),
  /** session_pid / bash_intent. Working directory at event time. */
  cwd: z.string().optional(),
  /** session_pid only. Unix seconds when the process started. */
  start_ts: z.number().optional(),
  /** bash_intent only. The Bash tool command string. */
  command: z.string().optional(),
  /** bash_intent only. Whether the Bash tool was invoked with run_in_background. */
  run_in_background: z.boolean().optional(),
  /** bash_id_map only. Claude tool_use id. */
  tool_use_id: z.string().optional(),
  /** bash_id_map only. Background bash id assigned by Claude Code. */
  bash_id: z.string().optional(),
  /** session_pid only. Value of $CLAUDE_CONFIG_DIR at hook time, when
   * present. Resolved upstream to an account_label via prefs.roots[].path. */
  claude_config_dir: z.string().nullable().optional(),
  /** session_pid only. The iTerm2 session GUID (the part after the colon in
   * $ITERM_SESSION_ID), captured when the session was launched from an iTerm2
   * pane. Lets the UI reveal the owning terminal tab. Null outside iTerm2. */
  iterm_session_id: z.string().nullable().optional(),
  /** Unix seconds, set by the dispatcher. */
  ts: z.number(),
});
export type HookEvent = z.infer<typeof HookEventSchema>;

export function defaultEventsDir(): string {
  if (process.env.BRAINHOUSE_EVENTS_DIR) return path.resolve(process.env.BRAINHOUSE_EVENTS_DIR);
  return path.join(os.homedir(), '.brainhouse', 'events');
}

export type HookEventHandler = (event: HookEvent) => void | Promise<void>;

export class HookEventWatcher {
  readonly dir: string;
  private readonly onEvent: HookEventHandler;
  private watcher: Watcher | null = null;
  /** Per-file byte offset of the next unread byte. Survives `change` events
   * so partial-line writes resume cleanly on the next change. */
  private readonly offsets = new Map<string, number>();

  constructor(dir: string, onEvent: HookEventHandler) {
    this.dir = dir;
    this.onEvent = onEvent;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Deterministic initial replay: drain every existing hook file to EOF and
    // AWAIT it before returning. Cold-start liveness priming depends on this —
    // the monitor runs the first process tick right after start() resolves, and
    // it can only attribute running `claude` processes to sessions once every
    // historical `session_pid` record has been registered. (The live `add`
    // handler below fires its drains fire-and-forget, so relying on chokidar's
    // initial scan would race the tick.)
    try {
      const entries = await readdir(this.dir);
      await Promise.all(
        entries
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => this.drain(path.join(this.dir, f))),
      );
    } catch {
      // Dir vanished / race — the live watch below still catches up.
    }
    // The explicit replay above already covered existing files (and per-file
    // offsets dedupe any overlap), so only tail subsequent writes. Flat dir →
    // non-recursive; the .jsonl filter lives in the handler.
    this.watcher = startWatcher([this.dir], {
      recursive: false,
      onEvent: (p) => {
        if (!p.endsWith('.jsonl')) return;
        void this.drain(p);
      },
    });
    await this.watcher.ready;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.offsets.clear();
  }

  /** Read from the last-known offset to EOF, parse each complete line, and
   * advance the offset. Called on both `add` and `change`. */
  private async drain(file: string): Promise<void> {
    let size: number;
    try {
      const s = await stat(file);
      size = s.size;
    } catch {
      return;
    }
    const start = this.offsets.get(file) ?? 0;
    if (size <= start) {
      this.offsets.set(file, size);
      return;
    }
    const stream = createReadStream(file, { start, end: size - 1, encoding: 'utf8' });
    const rl = createInterface({ input: stream });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const parsed = HookEventSchema.safeParse(raw);
      if (!parsed.success) continue;
      try {
        await this.onEvent(parsed.data);
      } catch {
        // Handler errors must not stop the tail.
      }
    }
    this.offsets.set(file, size);
  }
}
