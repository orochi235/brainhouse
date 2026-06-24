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
  /** Parent files older than `bootstrapAgeSeconds` but with mtime within
   * this bound are collected for background summarization instead of
   * ingested. 0/undefined disables. */
  deferredMaxAgeSeconds?: number;
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
  private readonly deferredMaxAgeSeconds: number;
  private readonly deferred: string[] = [];
  private readonly chokidarOptions: ChokidarOptions;
  private readonly offsets = new Map<string, number>();
  private readonly store: Store | null;
  private chokidarWatcher: FSWatcher | null = null;
  private processing: Promise<void> = Promise.resolve();

  constructor(roots: string[], onEvent: EventListener, opts: WatcherOptions = {}) {
    this.roots = roots.map((r) => path.resolve(r));
    this.onEvent = onEvent;
    this.bootstrapAgeSeconds = opts.bootstrapAgeSeconds ?? 30 * 60;
    this.deferredMaxAgeSeconds = opts.deferredMaxAgeSeconds ?? 0;
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
        if (!hasOffset && mtime < cutoff) {
          const deferCutoff = Date.now() / 1000 - this.deferredMaxAgeSeconds;
          if (
            this.deferredMaxAgeSeconds > 0 &&
            mtime >= deferCutoff &&
            !this.alreadySummarized(info.session_id, mtime)
          ) {
            this.deferred.push(file);
          }
          continue;
        }
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

  /** True when the store already holds a session_summary for this session
   * that's at least as fresh as the transcript on disk. Lets bootstrap skip
   * re-deferring work the background indexer has already completed, so the
   * deferred queue shrinks to outstanding files only.
   *
   * This is what makes the back-fill durable: `runToCompletion` drains the
   * queue once per start, so an indexer pass cut short by a restart used to
   * drop its tail and re-process the same prefix next time — a band of older
   * sessions could stay unsummarized forever. Excluding finished sessions
   * makes each restart re-queue just what's still missing, so progress is
   * monotonic. No store (persistence off) → nothing is known summarized. */
  private alreadySummarized(sessionId: string, mtime: number): boolean {
    const row = this.store?.getSession(sessionId);
    // A blank cwd means an older indexer pass wrote an incomplete row (it's
    // invisible in cwd-keyed project widgets). Treat it as unsummarized so the
    // back-fill re-runs it — current summarizeOffline recovers the cwd from
    // the transcript.
    return !!row && !!row.cwd && row.rolled_up_at >= mtime;
  }

  /** Hand off the files collected for background summarization, clearing the
   * internal queue. Parent transcript paths only (subagents are summarized
   * with their parent on the live path). */
  takeDeferredFiles(): string[] {
    return this.deferred.splice(0, this.deferred.length);
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
    for (const event of await this.metaEvents(p, info)) this.onEvent(event, this.findRoot(p));
  }

  /** Build the synthetic `subagent-meta` event(s) for a `.meta.json` sidecar.
   * Shared by the live {@link emitMeta} path and the on-demand reopen path
   * ({@link parseMetaFile}). Empty when the file is unreadable. */
  private async metaEvents(p: string, info: PathInfo): Promise<Event[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(p, 'utf8'));
    } catch {
      return [];
    }
    // The synthetic event carries no inline ts; stampFallbackTs gives it the
    // meta.json's mtime (subagent creation time) — the same single defaulting
    // step the tail path uses, so a bootstrap-replayed old subagent reflects
    // its real last activity instead of wall-clock-now.
    return this.stampFallbackTs(
      [
        {
          session_id: info.session_id,
          agent_id: info.agent_id,
          uuid: `${info.agent_id}:meta`,
          parent_uuid: null,
          ts: '',
          cwd: null,
          kind: 'meta',
          tags: ['meta'],
          payload: { record_type: 'subagent-meta', raw },
        },
      ],
      p,
    );
  }

  /** Parse a subagent `.meta.json` sidecar into its synthetic event(s)
   * without emitting them — the on-demand reopen path ingests the result
   * directly (it doesn't go through the watcher's onEvent callback). Returns
   * empty for non-meta paths. */
  async parseMetaFile(absPath: string): Promise<Event[]> {
    const info = classifyPath(absPath);
    if (!info?.is_meta) return [];
    return this.metaEvents(absPath, info);
  }

  /** Enumerate a parent session's subagent transcript files for on-demand
   * reopen. `parentFile` is the parent `<...>/<sessionId>.jsonl`; subagents
   * live in the sibling `<sessionId>/subagents/` dir. Returns absolute paths,
   * meta sidecars separate from jsonl so the caller can ingest meta first
   * (titles resolve before content). Empty when the dir is absent. */
  async subagentFilesFor(parentFile: string): Promise<{ jsonl: string[]; meta: string[] }> {
    const sessionId = path.basename(parentFile, '.jsonl');
    const dir = path.join(path.dirname(parentFile), sessionId, 'subagents');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const jsonl: string[] = [];
    const meta: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.meta.json')) meta.push(full);
      else if (entry.name.endsWith('.jsonl')) jsonl.push(full);
    }
    return { jsonl, meta };
  }

  /** Give a record its default age from the backing file's mtime.
   *
   * Claude Code omits the inline `timestamp` on side-channel records
   * (custom-title, last-prompt, ai-title, file-history-snapshot,
   * permission-mode). Left empty, those reach `apply()` and fall back to
   * wall-clock-now, so a panel first seen via such a record gets an age pinned
   * to server-start instead of its real last activity. The file the record
   * lives in always has an mtime (≈ last write), which is the right default.
   *
   * This is the SINGLE place that default is applied. Every path that turns a
   * file into events — the live tail, the `.meta.json` sidecar, the on-demand
   * reopen, the background indexer — must run its events through here so they
   * can't drift apart again (the tail path lacking what the meta path had is
   * exactly the bug this fixes). The per-path file *reading* stays separate
   * (incremental tail vs. whole-file vs. JSON sidecar are genuinely different);
   * only this ts-defaulting step is shared. */
  private stampFallbackTs(events: Event[], filePath: string): Event[] {
    if (!events.some((e) => !e.ts)) return events;
    let mtimeIso = '';
    try {
      mtimeIso = new Date(statSync(filePath).mtimeMs).toISOString();
    } catch {
      // file gone — leave empty so apply() falls back to clock-now
    }
    if (mtimeIso) for (const e of events) if (!e.ts) e.ts = mtimeIso;
    return events;
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
      const events = this.stampFallbackTs(
        parseLine(parsed as Record<string, unknown>, {
          session_id: info.session_id,
          agent_id: info.agent_id,
        }),
        p,
      );
      const sourceRoot = this.findRoot(p);
      for (const event of events) this.onEvent(event, sourceRoot);
    }
  }

  /** Read an entire transcript file and return its parsed events. Unlike
   * `tailJsonl`, this ignores byte offsets and never calls `onEvent` — a pure
   * read used by the background indexer and on-demand reopen. */
  async parseFile(absPath: string): Promise<Event[]> {
    const info = classifyPath(absPath);
    if (!info || info.is_meta) return [];
    let text: string;
    try {
      text = await readFile(absPath, 'utf8');
    } catch {
      return [];
    }
    const out: Event[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      for (const event of parseLine(parsed as Record<string, unknown>, {
        session_id: info.session_id,
        agent_id: info.agent_id,
      })) {
        out.push(event);
      }
    }
    return this.stampFallbackTs(out, absPath);
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
