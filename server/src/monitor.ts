/**
 * TranscriptMonitor wires the watcher and session store together and exposes
 * a delta stream for subscribers.
 *
 * Mirrors brainhouse/app.py:Application — bridges Event arrival → SessionStore
 * mutations → Delta broadcast, plus drives the periodic tick that advances
 * live → done → mini → removed transitions.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { defaultEventsDir, type HookEvent, HookEventWatcher } from './hookEvents.js';
import type { Event } from './parser.js';
import { type Delta, SessionStore } from './session.js';
import type { Store } from './store.js';
import { readPanelTheme } from './theme.js';
import { TranscriptWatcher } from './watcher.js';

export interface MonitorOptions {
  roots: string[];
  /** Optional human-readable labels per root path (e.g. "personal", "work").
   * Used to stamp panels with their owning-account so the client can render
   * a badge when multiple accounts are configured. */
  accounts?: Array<{ path: string; label?: string }>;
  idleSeconds?: number;
  miniSeconds?: number;
  removeAfterSeconds?: number;
  tickIntervalMs?: number;
  /** Directory the hook dispatcher writes sidecar JSONL into. Defaults to
   * `~/.brainhouse/events`. Set to `null` to disable hook ingestion. */
  hookEventsDir?: string | null;
  /** Optional persistence layer. When provided, SessionStore mirrors panel
   * state into SQLite on every transition; `start()` hydrates from it. */
  store?: Store | null;
  /** Events-index retention window in days. Rows older than this get
   * pruned on boot + once daily. Default 30 days. Ignored when no
   * `store` is provided. */
  eventsIndexRetentionDays?: number;
}

const DEFAULT_EVENTS_RETENTION_DAYS = 30;
const DAILY_PRUNE_MS = 24 * 60 * 60 * 1000;
/** Recency window for SessionStart supersession. A `/clear` or `/compact`
 * follows immediately on the heels of real activity; if the most recent
 * non-ended panel in the same project dir has been idle longer than this
 * we assume it's a different terminal and leave it alone. */
const SUPERSEDE_WITHIN_SECONDS = 5 * 60;
/** Delay between dim (on /clear or /compact supersede) and forced
 * minimize. The dim happens immediately via markEnded; the minimize
 * fires after this delay unless the panel is pinned at fire time. */
const SUPERSEDE_MINI_DELAY_MS = 5_000;

export class TranscriptMonitor {
  readonly store: SessionStore;
  /** The current watcher. Mutable so we can hot-swap when prefs.roots
   * changes — old one drains and stops, new one starts in its place. */
  watcher: TranscriptWatcher;
  readonly emitter = new EventEmitter();
  private tickIntervalMs: number;
  private tickHandle: NodeJS.Timeout | null = null;
  private hookWatcher: HookEventWatcher | null = null;
  private pruneHandle: NodeJS.Timeout | null = null;
  private eventsIndexRetentionDays: number;
  /** rootPath → label. Used to translate watcher "sourceRoot" into a
   * human-readable account name on each ingest. */
  private readonly accountLabels: Map<string, string>;
  /** Held for setRoots(), which constructs a fresh watcher and needs the
   * same persistence handle. */
  private readonly persistStore: import('./store.js').Store | null;

  constructor(opts: MonitorOptions) {
    this.persistStore = opts.store ?? null;
    this.store = new SessionStore({
      idleSeconds: opts.idleSeconds,
      miniSeconds: opts.miniSeconds,
      removeAfterSeconds: opts.removeAfterSeconds,
      store: opts.store ?? null,
    });
    this.accountLabels = new Map();
    for (const a of opts.accounts ?? []) {
      if (a.label) this.accountLabels.set(a.path, a.label);
    }
    this.watcher = new TranscriptWatcher(
      opts.roots,
      (event, sourceRoot) => this.ingest(event, sourceRoot),
      { store: opts.store ?? null },
    );
    this.tickIntervalMs = opts.tickIntervalMs ?? 5000;
    this.eventsIndexRetentionDays = opts.eventsIndexRetentionDays ?? DEFAULT_EVENTS_RETENTION_DAYS;
    const dir = opts.hookEventsDir === undefined ? defaultEventsDir() : opts.hookEventsDir;
    if (dir) {
      this.hookWatcher = new HookEventWatcher(dir, (e) => this.applyHookEvent(e));
    }
    // Default emitter caps listener count at 10; the WS subscribers will easily
    // exceed that during dev with HMR opening fresh connections.
    this.emitter.setMaxListeners(100);
  }

  async start({ watch = true }: { watch?: boolean } = {}): Promise<void> {
    // Hydrate from persisted state BEFORE the watcher kicks in so any
    // bootstrap replays land on top of last-known panel state rather than
    // starting fresh. No-op when persistence is disabled.
    this.store.hydrate();
    // After hydrate, every panel.events[] is empty (we only persist panel
    // metadata, not full event payloads). Wipe bootstrap_offsets so the
    // watcher re-reads the recent JSONL window and the event arrays
    // repopulate. Offsets are still useful within a single process
    // lifetime (e.g. setRoots hot-swap mid-run); just not across restarts.
    this.persistStore?.clearAllBootstrapOffsets();
    await this.watcher.start({ watch });
    if (this.hookWatcher) await this.hookWatcher.start();
    this.startTick();
    this.startPruneLoop();
  }

  /** Drop events_index rows older than the retention window. Runs on
   * start() + once a day. Idempotent; no-op when persistence is off. */
  private prune(): void {
    if (!this.persistStore) return;
    const cutoff = Date.now() / 1000 - this.eventsIndexRetentionDays * 86_400;
    this.persistStore.pruneEventsBefore(cutoff);
  }

  private startPruneLoop(): void {
    if (this.pruneHandle) clearInterval(this.pruneHandle);
    this.prune();
    if (!this.persistStore) return;
    this.pruneHandle = setInterval(() => this.prune(), DAILY_PRUNE_MS);
    // Don't keep the process alive just for the prune timer.
    this.pruneHandle.unref?.();
  }

  /** Update the retention window at runtime (called by prefs.update). */
  setEventsIndexRetentionDays(days: number): void {
    this.eventsIndexRetentionDays = days;
    this.prune();
  }

  private startTick(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = setInterval(() => {
      for (const delta of this.store.tick()) this.broadcast(delta);
    }, this.tickIntervalMs);
  }

  /** Hot-swap lifecycle timings + tick interval. Used from `prefs.update`
   * when `prefs.timings` changes — no server restart needed. */
  setTimings(opts: {
    idleSeconds?: number;
    miniSeconds?: number;
    removeAfterSeconds?: number;
    tickIntervalMs?: number;
  }): void {
    this.store.setTimings(opts);
    if (opts.tickIntervalMs !== undefined && opts.tickIntervalMs !== this.tickIntervalMs) {
      this.tickIntervalMs = opts.tickIntervalMs;
      if (this.tickHandle) this.startTick();
    }
  }

  async stop(): Promise<void> {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
    if (this.pruneHandle) clearInterval(this.pruneHandle);
    this.pruneHandle = null;
    await this.watcher.stop();
    if (this.hookWatcher) await this.hookWatcher.stop();
  }

  /** When SessionStart fires with source ∈ {clear, compact}, retire the
   * prior live panel in the same project dir. Other sources (startup,
   * resume) leave the world alone — they don't imply a predecessor was
   * abandoned. We can't trust cwd alone (multiple terminals in the same
   * directory is common) so we narrow further via a recency window in
   * `findSupersedablePanel`. */
  private applySessionStartSupersede(event: HookEvent): void {
    if (event.kind !== 'session_start') return;
    const source = event.source;
    if (source !== 'clear' && source !== 'compact') return;
    if (!event.transcript_path) return;
    const encodedCwdDir = path.basename(path.dirname(event.transcript_path));
    if (!encodedCwdDir) return;
    const target = this.store.findSupersedablePanel({
      encodedCwdDir,
      excludeId: event.session_id,
      now: event.ts,
      withinSeconds: SUPERSEDE_WITHIN_SECONDS,
    });
    if (!target) return;
    for (const d of this.store.forceStatus(target.id, 'done')) this.broadcast(d);
    for (const d of this.store.markEnded(target.id, 'hook_session_start_supersede')) {
      this.broadcast(d);
    }
    this.scheduleSupersedeMini(target.id);
    for (const sub of this.store.liveSubagentsOf(target.id)) {
      for (const d of this.store.forceStatus(sub.id, 'done')) this.broadcast(d);
      for (const d of this.store.markEnded(sub.id, 'hook_session_start_supersede')) {
        this.broadcast(d);
      }
      this.scheduleSupersedeMini(sub.id);
    }
  }

  /** Force `panelId` to `mini` SUPERSEDE_MINI_DELAY_MS after a /clear or
   * /compact supersede. The dim already fired via markEnded; this just
   * accelerates the done→mini transition (normally `miniSeconds`, default
   * 5 min) so a cleared session disappears from the grid quickly. Skipped
   * at fire time if the panel is pinned, has been re-promoted to live, or
   * is already mini/gone. */
  private scheduleSupersedeMini(panelId: string): void {
    const handle = setTimeout(() => {
      const panel = this.store.panel(panelId);
      if (!panel) return;
      if (panel.status !== 'done') return;
      if (this.persistStore?.getIntentions(panelId)?.pinned) return;
      for (const d of this.store.forceStatus(panelId, 'mini')) this.broadcast(d);
    }, SUPERSEDE_MINI_DELAY_MS);
    handle.unref?.();
  }

  /** Translate a sidecar hook event into lifecycle deltas. Each event kind
   * targets the parent panel by `session_id`; SubagentStop also demotes any
   * live subagents under that parent. */
  applyHookEvent(event: HookEvent): void {
    const sid = event.session_id;
    if (event.kind === 'stop') {
      for (const d of this.store.forceStatus(sid, 'done')) this.broadcast(d);
      // Materialize a session_summary with hook_stop provenance, but do
      // NOT flip `ended` — a parent session can take another prompt later
      // and shouldn't visually dim on Stop alone.
      this.store.recordSessionEnd(sid, 'hook_stop');
      return;
    }
    if (event.kind === 'subagent_stop') {
      for (const sub of this.store.liveSubagentsOf(sid)) {
        for (const d of this.store.forceStatus(sub.id, 'done')) this.broadcast(d);
        // Subagents finish for real — we trust SubagentStop as an explicit
        // end signal. Dimming flips on via `ended`.
        for (const d of this.store.markEnded(sub.id)) this.broadcast(d);
      }
      return;
    }
    if (event.kind === 'notification') {
      for (const d of this.store.setAwaiting(sid, true)) this.broadcast(d);
      return;
    }
    if (event.kind === 'session_start') {
      this.applySessionStartSupersede(event);
      return;
    }
    if (event.kind === 'auto_title') {
      const title = (event.title ?? '').trim();
      if (!title) return;
      for (const d of this.store.applyAutoTitle(sid, title)) this.broadcast(d);
      return;
    }
    if (event.kind === 'hook_overhead') {
      const tokens = Number(event.tokens) || 0;
      if (tokens <= 0) return;
      for (const d of this.store.recordHookOverhead(sid, tokens)) this.broadcast(d);
      return;
    }
    if (event.kind === 'session_end') {
      // Authoritative terminate signal — Claude Code is shutting down this
      // session for real. Mark the parent panel ended and demote any live
      // subagents under it. Stop hooks only end the assistant turn;
      // session_end is the whole-session terminator.
      for (const d of this.store.forceStatus(sid, 'done')) this.broadcast(d);
      for (const d of this.store.markEnded(sid, 'hook_session_end')) this.broadcast(d);
      for (const sub of this.store.liveSubagentsOf(sid)) {
        for (const d of this.store.forceStatus(sub.id, 'done')) this.broadcast(d);
        for (const d of this.store.markEnded(sub.id, 'hook_session_end')) this.broadcast(d);
      }
      return;
    }
  }

  /**
   * Hot-swap the watched roots + account labels without dropping the existing
   * SessionStore, tick interval, or delta subscribers. Used when prefs are
   * edited at runtime: the watcher drains its in-flight processing, gets
   * torn down, and a fresh one starts on the new roots.
   *
   * Sessions whose source root is no longer in the list keep their existing
   * panel state — they just stop receiving new events.
   */
  async setRoots(
    roots: string[],
    accounts: Array<{ path: string; label?: string }> = [],
  ): Promise<void> {
    await this.watcher.stop();
    this.accountLabels.clear();
    for (const a of accounts) if (a.label) this.accountLabels.set(a.path, a.label);
    this.watcher = new TranscriptWatcher(
      roots,
      (event, sourceRoot) => this.ingest(event, sourceRoot),
      { store: this.persistStore },
    );
    await this.watcher.start({ watch: true });
  }

  /** Push a synthesized event (used by both the watcher and debug spawns).
   * `sourceRoot` is the root the event came from; resolved to an account
   * label before being stamped on the panel. */
  ingest(event: Event, sourceRoot?: string): void {
    const accountLabel = sourceRoot ? (this.accountLabels.get(sourceRoot) ?? null) : null;
    for (const delta of this.store.apply(event, { accountLabel })) this.broadcast(delta);
  }

  private broadcast(delta: Delta): void {
    this.emitter.emit('delta', delta);
    // When a panel announces (or upgrades) its cwd, try to load that
    // project's .hued theme. The read is async; once it lands, the store
    // emits another panel_upsert with the theme attached.
    if (delta.op === 'panel_upsert' && delta.panel.cwd && !delta.panel.theme) {
      void this.loadThemeFor(delta.panel.id, delta.panel.cwd);
    }
  }

  private async loadThemeFor(panelId: string, cwd: string): Promise<void> {
    const theme = await readPanelTheme(cwd);
    if (!theme) return;
    for (const delta of this.store.setTheme(panelId, theme)) {
      this.emitter.emit('delta', delta);
    }
  }
}
