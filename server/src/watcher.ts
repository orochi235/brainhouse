/**
 * Tails Claude Code transcript JSONL files under one or more project roots.
 *
 * Layout consumed:
 *   <root>/<encoded-cwd>/<session-uuid>.jsonl                          parent session
 *   <root>/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.jsonl     subagent
 *   <root>/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.meta.json subagent metadata
 *
 * Mirrors pensieve/watcher.py:
 *   - per-file byte offset, partial-line buffering across writes
 *   - first-sight optimization: read sibling .meta.json the first time a
 *     subagent jsonl is encountered so the panel title upgrades immediately
 *   - .meta.json files emit a synthetic subagent-meta event
 */

import { existsSync, statSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import { type Event, parseLine } from './parser.js';

export interface PathInfo {
  session_id: string;
  agent_id: string | null;
  is_meta: boolean;
}

export function classifyPath(p: string): PathInfo | null {
  const name = path.basename(p);
  const parentDir = path.basename(path.dirname(p));

  if (name.endsWith('.meta.json') && parentDir === 'subagents') {
    const agent_id = name.slice(0, -'.meta.json'.length);
    const session_id = path.basename(path.dirname(path.dirname(p)));
    return { session_id, agent_id, is_meta: true };
  }
  if (name.endsWith('.jsonl')) {
    if (parentDir === 'subagents') {
      const agent_id = name.slice(0, -'.jsonl'.length);
      const session_id = path.basename(path.dirname(path.dirname(p)));
      return { session_id, agent_id, is_meta: false };
    }
    const session_id = name.slice(0, -'.jsonl'.length);
    return { session_id, agent_id: null, is_meta: false };
  }
  return null;
}

/** Listener receives the parsed Event and the root the source file lives
 * under (one of `roots` passed to the watcher) so the caller can stamp the
 * panel with an owning-account label. */
export type EventListener = (event: Event, sourceRoot: string) => void;

export interface WatcherOptions {
  bootstrapAgeSeconds?: number;
  /** Extra chokidar options merged into the defaults. Mainly a test seam so
   * tests can force polling on platforms where fsevents coalesces rapid
   * appends. Production should leave this unset. */
  chokidarOptions?: ChokidarOptions;
}

export class TranscriptWatcher {
  readonly roots: string[];
  private readonly onEvent: EventListener;
  private readonly bootstrapAgeSeconds: number;
  private readonly chokidarOptions: ChokidarOptions;
  private readonly offsets = new Map<string, number>();
  private chokidarWatcher: FSWatcher | null = null;
  private processing: Promise<void> = Promise.resolve();

  constructor(roots: string[], onEvent: EventListener, opts: WatcherOptions = {}) {
    this.roots = roots.map((r) => path.resolve(r));
    this.onEvent = onEvent;
    this.bootstrapAgeSeconds = opts.bootstrapAgeSeconds ?? 30 * 60;
    this.chokidarOptions = opts.chokidarOptions ?? {};
  }

  async start({ watch = true }: { watch?: boolean } = {}): Promise<void> {
    await this.bootstrap();
    if (!watch) return;
    const watcher = chokidar.watch(this.roots, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      persistent: true,
      ...this.chokidarOptions,
    });
    this.chokidarWatcher = watcher;
    const handle = (p: string) => {
      this.processing = this.processing.then(() => this.processPath(p)).catch(() => undefined);
    };
    watcher.on('add', handle).on('change', handle);
    // Wait for chokidar's initial scan to complete so writes that land
    // immediately after start() can't slip through before the watch is armed.
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    if (this.chokidarWatcher) {
      await this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }
    await this.processing;
  }

  async bootstrap(): Promise<void> {
    const cutoff = Date.now() / 1000 - this.bootstrapAgeSeconds;
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      for (const file of await this.walk(root)) {
        if (!classifyPath(file)) continue;
        try {
          if (statSync(file).mtimeMs / 1000 < cutoff) continue;
        } catch {
          continue;
        }
        await this.processPath(file);
      }
    }
  }

  /**
   * Read new bytes from path (or the whole .meta.json) and emit Events.
   * Reads are serialized via the `processing` chain so concurrent watcher
   * events for the same file can't interleave.
   */
  async processPath(p: string): Promise<void> {
    const info = classifyPath(p);
    if (!info) return;
    if (info.is_meta) {
      await this.emitMeta(p, info);
      return;
    }
    // First-sight optimization: also process the sibling .meta.json so the
    // subagent's human-readable title appears immediately.
    const firstSight = !this.offsets.has(p);
    if (firstSight && info.agent_id !== null) {
      const metaPath = path.join(path.dirname(p), `${info.agent_id}.meta.json`);
      if (existsSync(metaPath)) {
        const metaInfo = classifyPath(metaPath);
        if (metaInfo?.is_meta) await this.emitMeta(metaPath, metaInfo);
      }
    }
    await this.tailJsonl(p, info);
  }

  private async emitMeta(p: string, info: PathInfo): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(p, 'utf8'));
    } catch {
      return;
    }
    this.onEvent(
      {
        session_id: info.session_id,
        agent_id: info.agent_id,
        uuid: `${info.agent_id}:meta`,
        parent_uuid: null,
        ts: '',
        cwd: null,
        kind: 'meta',
        payload: { record_type: 'subagent-meta', raw },
      },
      this.findRoot(p),
    );
  }

  /** Find which configured root a given path lives under. Returns the
   * matched root, or the first root as a fallback (matching never fails in
   * practice since chokidar only reports paths inside the watched roots). */
  private findRoot(p: string): string {
    const abs = path.resolve(p);
    for (const r of this.roots) if (abs.startsWith(`${r}${path.sep}`) || abs === r) return r;
    return this.roots[0] ?? '';
  }

  private async tailJsonl(p: string, info: PathInfo): Promise<void> {
    const offset = this.offsets.get(p) ?? 0;
    let buf: Buffer;
    const handle = await open(p, 'r').catch(() => null);
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size <= offset) return;
      buf = Buffer.alloc(size - offset);
      await handle.read(buf, 0, buf.length, offset);
    } catch {
      return;
    } finally {
      await handle.close().catch(() => undefined);
    }

    const lastNewline = buf.lastIndexOf(0x0a /* \n */);
    if (lastNewline === -1) return; // no complete line yet
    const complete = buf.subarray(0, lastNewline + 1);
    this.offsets.set(p, offset + lastNewline + 1);

    for (const line of complete.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const events = parseLine(parsed as Record<string, unknown>, {
        session_id: info.session_id,
        agent_id: info.agent_id,
      });
      const sourceRoot = this.findRoot(p);
      for (const event of events) this.onEvent(event, sourceRoot);
    }
  }

  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) out.push(full);
      }
    };
    await visit(root);
    return out;
  }
}
