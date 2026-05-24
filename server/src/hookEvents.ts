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
import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import chokidar, { type FSWatcher } from 'chokidar';
import { z } from 'zod';

export const HookEventSchema = z.object({
  kind: z.enum([
    'stop',
    'subagent_stop',
    'notification',
    'session_end',
    'session_start',
    'auto_title',
    'hook_overhead',
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
  /** hook_overhead only. Which brainhouse hook injected context. */
  hook_name: z.string().optional(),
  /** hook_overhead only. Estimated tokens added to the next turn's
   * context by this hook's output (chars/4 proxy). */
  tokens: z.number().optional(),
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
  private watcher: FSWatcher | null = null;
  /** Per-file byte offset of the next unread byte. Survives `change` events
   * so partial-line writes resume cleanly on the next change. */
  private readonly offsets = new Map<string, number>();

  constructor(dir: string, onEvent: HookEventHandler) {
    this.dir = dir;
    this.onEvent = onEvent;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Chokidar v4 dropped built-in glob support — watch the dir, filter in
    // the handler.
    this.watcher = chokidar.watch(this.dir, {
      ignoreInitial: false,
      awaitWriteFinish: false,
      persistent: true,
      depth: 0,
    });
    const handle = (p: string) => {
      if (!p.endsWith('.jsonl')) return;
      void this.drain(p);
    };
    this.watcher.on('add', handle);
    this.watcher.on('change', handle);
    await new Promise<void>((resolve) => {
      if (!this.watcher) return resolve();
      this.watcher.once('ready', () => resolve());
    });
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
