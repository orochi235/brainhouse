/**
 * Tails Claude Code transcript JSONL files under one or more project roots.
 *
 * Layout consumed:
 *   <root>/<encoded-cwd>/<session-uuid>.jsonl                          parent session
 *   <root>/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.jsonl     subagent
 *   <root>/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.meta.json subagent metadata
 *
 * Mirrors brainhouse/watcher.py:
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
import type { Store } from './store.js';

export interface PathInfo {
  session_id: string;
  agent_id: string | null;
  is_meta: boolean;
}

/** Subagent files are named `agent-<uuid>.{jsonl,meta.json}` on disk, but
 * Claude Code writes the bare `<uuid>` into the `agentId` field of each
 * JSONL row. We strip the prefix here so the path-derived id and the
 * row-derived id agree — otherwise a single subagent ends up as two panels
 * (one fed by the .meta.json sidecar, the other by the transcript). */
function stripAgentPrefix(id: string): string {
  return id.startsWith('agent-') ? id.slice('agent-'.length) : id;
}

export function classifyPath(p: string): PathInfo | null {
  const name = path.basename(p);
  const parentDir = path.basename(path.dirname(p));

  if (name.endsWith('.meta.json') && parentDir === 'subagents') {
    const agent_id = stripAgentPrefix(name.slice(0, -'.meta.json'.length));
    const session_id = path.basename(path.dirname(path.dirname(p)));
    return { session_id, agent_id, is_meta: true };
  }
  if (name.endsWith('.jsonl')) {
    if (parentDir === 'subagents') {
      const agent_id = stripAgentPrefix(name.slice(0, -'.jsonl'.length));
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
  /** Optional persistence layer. When set, per-file byte offsets persist
   * to `bootstrap_offsets`; a server restart resumes from where each
   * file's tail left off instead of replaying the trailing N minutes. */
  store?: Store | null;
}

export class TranscriptWatcher {
  readonly roots: string[];
  private readonly onEvent: EventListener;
  private readonly bootstrapAgeSeconds: number;
  private readonly chokidarOptions: ChokidarOptions;
  private readonly offsets = new Map<string, number>();
  private readonly store: Store | null;
  private chokidarWatcher: FSWatcher | null = null;
  private processing: Promise<void> = Promise.resolve();

  constructor(roots: string[], onEvent: EventListener, opts: WatcherOptions = {}) {
    this.roots = roots.map((r) => path.resolve(r));
    this.onEvent = onEvent;
    this.bootstrapAgeSeconds = opts.bootstrapAgeSeconds ?? 30 * 60;
    this.chokidarOptions = opts.chokidarOptions ?? {};
    this.store = opts.store ?? null;
  }

  async start({ watch = true }: { watch?: boolean } = {}): Promise<void> {
    this.hydrateOffsets();
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

  /** Forget the persisted offset for a path and re-process it from byte 0.
   * Used by the dev "rebuild from log" affordance: after the caller wipes
   * the panel's in-memory + persisted state, this replays the JSONL so
   * the same events flow back through `monitor.ingest`. No-op when the
   * path doesn't classify as a transcript or doesn't exist.
   *
   * Serialized via the same `processing` chain chokidar uses, so a
   * concurrent change-event for the same file can't interleave: either
   * our reset+replay runs first and any subsequent chokidar event sees
   * the offset back at end-of-file, or chokidar's call runs first and
   * ours sees the up-to-date offset before resetting it. */
  async rereadFromStart(absPath: string): Promise<void> {
    if (!classifyPath(absPath)) return;
    if (!existsSync(absPath)) return;
    const run = async () => {
      this.offsets.delete(absPath);
      this.store?.deleteBootstrapOffset(absPath);
      await this.processPath(absPath);
    };
    this.processing = this.processing.then(run).catch(() => undefined);
    await this.processing;
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
      // Two passes: parents first so we know which session_ids are
      // "live" enough to bootstrap. Then subagents — always processed
      // when their parent session is live, regardless of mtime.
      // Otherwise a parent that's still being appended to bootstraps,
      // but its already-completed subagent transcripts (older than
      // bootstrapAgeSeconds) get silently dropped and never re-arrive
      // since chokidar only fires on further writes.
      const files = await this.walk(root);
      const liveSessions = new Set<string>();
      const subagentFiles: string[] = [];
      for (const file of files) {
        const info = classifyPath(file);
        if (!info) continue;
        if (info.agent_id !== null) {
          subagentFiles.push(file);
          continue;
        }
        let mtime: number;
        try {
          mtime = statSync(file).mtimeMs / 1000;
        } catch {
          continue;
        }
        const hasOffset = this.offsets.has(file);
        if (!hasOffset && mtime < cutoff) continue;
        liveSessions.add(info.session_id);
        await this.processPath(file);
      }
      for (const file of subagentFiles) {
        const info = classifyPath(file);
        if (!info) continue;
        const hasOffset = this.offsets.has(file);
        if (!hasOffset && !liveSessions.has(info.session_id)) {
          // Parent session wasn't bootstrapped — skip its subagents too,
          // matching the old behavior (don't resurrect ancient sessions).
          let mtime: number;
          try {
            mtime = statSync(file).mtimeMs / 1000;
          } catch {
            continue;
          }
          if (mtime < cutoff) continue;
        }
        await this.processPath(file);
      }
    }
  }

  /** Restore per-file offsets from the Store so a restart resumes
   * incrementally instead of re-replaying the trailing window. No-op
   * when persistence is disabled. */
  private hydrateOffsets(): void {
    if (!this.store) return;
    for (const [filePath, byteOffset] of this.store.allBootstrapOffsets()) {
      // Drop stale entries for files that no longer exist so the table
      // doesn't accumulate ghosts indefinitely.
      if (!existsSync(filePath)) {
        this.store.deleteBootstrapOffset(filePath);
        continue;
      }
      this.offsets.set(filePath, byteOffset);
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
    // subagent's human-readable title appears immediately. Derive the meta
    // filename from the jsonl filename rather than info.agent_id — the
    // file on disk is `agent-<uuid>.meta.json`, while info.agent_id is the
    // bare `<uuid>` we use as the panel key.
    const firstSight = !this.offsets.has(p);
    if (firstSight && info.agent_id !== null) {
      const jsonlName = path.basename(p);
      const metaName = `${jsonlName.slice(0, -'.jsonl'.length)}.meta.json`;
      const metaPath = path.join(path.dirname(p), metaName);
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
    // Use the meta.json's mtime as the synthetic event's ts so a brand-new
    // subagent panel seeded by this event starts with a realistic
    // last_event_at (subagent creation time) rather than wall-clock-now.
    // Without this, bootstrap-replaying an old subagent locks its
    // "last activity" timestamp to today and the +X idle timer always
    // reads 0 regardless of how stale the transcript actually is.
    let mtimeIso = '';
    try {
      mtimeIso = new Date(statSync(p).mtimeMs).toISOString();
    } catch {
      // file gone — leave empty so apply() falls back to clock-now
    }
    this.onEvent(
      {
        session_id: info.session_id,
        agent_id: info.agent_id,
        uuid: `${info.agent_id}:meta`,
        parent_uuid: null,
        ts: mtimeIso,
        cwd: null,
        kind: 'meta',
        tags: ['meta'],
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
    const newOffset = offset + lastNewline + 1;
    this.offsets.set(p, newOffset);
    this.store?.setBootstrapOffset(p, newOffset);

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
