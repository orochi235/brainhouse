/**
 * TranscriptMonitor wires the watcher and session store together and exposes
 * a delta stream for subscribers.
 *
 * Mirrors brainhouse/app.py:Application — bridges Event arrival → SessionStore
 * mutations → Delta broadcast, plus drives the periodic tick that advances
 * live → done → mini → removed transitions.
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { defaultEventsDir, type HookEvent, HookEventWatcher } from './hookEvents.js';
import type { Event } from './parser.js';
import type { ProcessTracker } from './processes/index.js';
import { deriveAccountLabel } from './roots.js';
import { type Delta, encodeCwdToProjectDir, SessionStore } from './session.js';
import type { Store } from './store.js';
import { type PanelTheme, readPanelTheme } from './theme.js';
import { isRealUserText, isSubstantiveAssistantText, Titler } from './titler.js';
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
  /** When true (default), `/clear` and `/compact` supersedes force the
   * predecessor panel to `mini` after `SUPERSEDE_MINI_DELAY_MS`. When
   * false, the supersede still dims/ends the panel but lets the normal
   * done→mini timer take over. */
  autoMinimizeOnClear?: boolean;
  /** Optional process tracker. Hook events of kind session_pid /
   * bash_intent / bash_id_map are forwarded here; stop / session_end
   * are forwarded as well (in addition to the panel-lifecycle handling). */
  tracker?: ProcessTracker | null;
  /** Returns true when `display.autoTitle` is enabled. Read fresh on each
   * evaluation so a runtime prefs flip takes effect without a restart.
   * Defaults to `() => true` when omitted. */
  isAutoTitleEnabled?: () => boolean;
}

const DEFAULT_EVENTS_RETENTION_DAYS = 30;
const DAILY_PRUNE_MS = 24 * 60 * 60 * 1000;
/** Recency window for SessionStart supersession. A `/clear` or `/compact`
 * follows immediately on the heels of real activity; if the most recent
 * non-ended panel in the same project dir has been idle longer than this
 * we assume it's a different terminal and leave it alone. */
const SUPERSEDE_WITHIN_SECONDS = 5 * 60;
/** Skip supersede candidates whose last event is *too* recent (within this
 * many seconds of the new SessionStart). An actively-responding session
 * in another terminal in the same cwd would otherwise be the "best"
 * (most recent) candidate and get wrongly killed. After typing /clear,
 * the prior session in the same terminal stopped emitting events at
 * least a beat before the new SessionStart hook fired, so a small idle
 * floor reliably separates "the prior session" from "an unrelated live
 * session." */
const SUPERSEDE_MIN_IDLE_SECONDS = 2;
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
  private autoMinimizeOnClear: boolean;
  private tracker: ProcessTracker | null = null;
  private readonly titler: Titler;
  /** rootPath → label. Used to translate watcher "sourceRoot" into a
   * human-readable account name on each ingest. */
  private readonly accountLabels: Map<string, string>;
  /** Held for setRoots(), which constructs a fresh watcher and needs the
   * same persistence handle. Public so debug instrumentation can dump
   * the bootstrap_offsets table without going through SessionStore. */
  readonly persistStore: import('./store.js').Store | null;

  constructor(opts: MonitorOptions) {
    this.persistStore = opts.store ?? null;
    this.store = new SessionStore({
      idleSeconds: opts.idleSeconds,
      miniSeconds: opts.miniSeconds,
      removeAfterSeconds: opts.removeAfterSeconds,
      store: opts.store ?? null,
      // Process-aware liveness: don't let a session flip to `done` while its
      // owning `claude` process is still alive. Lazy `this.tracker` read —
      // the tracker is wired after this constructor but always before tick().
      isSessionLive: (sessionId) => this.tracker?.liveSessionIds().has(sessionId) ?? false,
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
    this.autoMinimizeOnClear = opts.autoMinimizeOnClear ?? true;
    this.tracker = opts.tracker ?? null;
    const isAutoTitleEnabled = opts.isAutoTitleEnabled ?? (() => true);
    this.titler = new Titler({
      getPanel: (panelId) => this.store.panel(panelId),
      isAutoTitleEnabled,
      applyAutoTitle: (panelId, proposed) => {
        for (const d of this.store.applyAutoTitle(panelId, proposed)) this.broadcast(d);
      },
    });
    const dir = opts.hookEventsDir === undefined ? defaultEventsDir() : opts.hookEventsDir;
    if (dir) {
      this.hookWatcher = new HookEventWatcher(dir, (e) => this.applyHookEvent(e));
    }
    // Default emitter caps listener count at 10; the WS subscribers will easily
    // exceed that during dev with HMR opening fresh connections.
    this.emitter.setMaxListeners(100);
  }

  async start({ watch = true }: { watch?: boolean } = {}): Promise<void> {
    this.hydrate();
    await this.startWatching({ watch });
  }

  /** Fast, synchronous-ish hydration from persisted state. Split out of
   * {@link start} so a host that binds an HTTP port can run this BEFORE
   * listening — the tRPC `snapshot`/`deltas` bootstrap then serves the
   * last-known panels the instant a client connects, while the slow
   * {@link startWatching} walk streams the rest in live. No-op when
   * persistence is disabled. */
  hydrate(): void {
    // Hydrate from persisted state BEFORE the watcher kicks in so any
    // bootstrap replays land on top of last-known panel state rather than
    // starting fresh.
    this.store.hydrate();
    // After hydrate, every panel.events[] is empty (we only persist panel
    // metadata, not full event payloads). Wipe bootstrap_offsets so the
    // watcher re-reads the recent JSONL window and the event arrays
    // repopulate. Offsets are still useful within a single process
    // lifetime (e.g. setRoots hot-swap mid-run); just not across restarts.
    this.persistStore?.clearAllBootstrapOffsets();
    // Hydrated panels reach subscribers through the initial trpc `snapshot`
    // event, which bypasses `broadcast()` and therefore skips the
    // lazy theme-load side effect. Re-attempt `.hued` for any panel that
    // came back theme-less so subsequently-added theme files actually
    // surface on restart instead of waiting for the next ingest.
    for (const dto of this.store.snapshot()) {
      if (dto.cwd && !dto.theme) void this.loadThemeFor(dto.id, dto.cwd);
    }
  }

  /** The slow half of boot: walk every transcript root, attach the hook
   * watcher, and start the periodic loops. A host that serves HTTP should
   * bind its port before calling this so the dev client never races a dead
   * socket (which spams the vite proxy with ECONNREFUSED and drops the
   * bootstrap subscriptions). Late subscribers still get a complete picture
   * — the tRPC snapshot reads live store state, which the walk mutates in
   * place. */
  async startWatching({ watch = true }: { watch?: boolean } = {}): Promise<void> {
    await this.watcher.start({ watch });
    // Bootstrap-time subagent replays produce panels with no SubagentStop
    // hook to drive a real end. Sweep any whose last event is older than
    // the idle window and mark them ended so the dock doesn't fill with
    // phantom "live" rows from prior days.
    for (const d of this.store.endStaleSubagents(this.store.idleSeconds)) this.broadcast(d);
    if (this.hookWatcher) await this.hookWatcher.start();
    this.startTick();
    this.startPruneLoop();
    this.startThemePoll();
  }

  private themePollHandle: NodeJS.Timeout | null = null;
  /** How often to re-stat every active panel's `.hued`. 10s is the sweet
   * spot: a single stat per panel cwd, cheap enough to run on every
   * iteration, but slow enough that editing `.hued` and saving feels
   * near-immediate. Tied to the same lifecycle as the lifecycle tick. */
  private readonly themePollMs = 10_000;
  private startThemePoll(): void {
    if (this.themePollHandle) clearInterval(this.themePollHandle);
    this.themePollHandle = setInterval(() => {
      void this.pollThemes();
    }, this.themePollMs);
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

  setAutoMinimizeOnClear(value: boolean): void {
    this.autoMinimizeOnClear = value;
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
    if (this.themePollHandle) clearInterval(this.themePollHandle);
    this.themePollHandle = null;
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
    // Manual /clear → arm inherited-title suppression on the new session
    // so Claude Code's re-emission of the prior session's custom-title
    // (carried over into the fresh transcript) doesn't auto-name the
    // post-clear panel after the conversation it's replacing. /compact
    // keeps the conversation so its title legitimately carries forward.
    if (source === 'clear') {
      for (const d of this.store.armClearTitleSuppression(event.session_id)) {
        this.broadcast(d);
      }
    }
    const encodedCwdDir = path.basename(path.dirname(event.transcript_path));
    if (!encodedCwdDir) return;
    const target = this.store.findSupersedablePanel({
      encodedCwdDir,
      excludeId: event.session_id,
      now: event.ts,
      withinSeconds: SUPERSEDE_WITHIN_SECONDS,
      minIdleSeconds: SUPERSEDE_MIN_IDLE_SECONDS,
    });
    if (!target) return;
    for (const d of this.store.forceStatus(target.id, 'done')) this.broadcast(d);
    for (const d of this.store.markEnded(target.id, 'hook_session_start_supersede')) {
      this.broadcast(d);
    }
    if (this.autoMinimizeOnClear) this.scheduleSupersedeMini(target.id);
    for (const sub of this.store.unendedSubagentsOf(target.id)) {
      for (const d of this.store.forceStatus(sub.id, 'done')) this.broadcast(d);
      for (const d of this.store.markEnded(sub.id, 'hook_session_start_supersede')) {
        this.broadcast(d);
      }
      if (this.autoMinimizeOnClear) this.scheduleSupersedeMini(sub.id);
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
    if (this.tracker) {
      if (
        event.kind === 'session_pid' ||
        event.kind === 'bash_intent' ||
        event.kind === 'bash_id_map'
      ) {
        // For session_pid, resolve the hook's CLAUDE_CONFIG_DIR to a
        // prefs root → account label and stamp it onto the record. Keeps
        // the resolution map on the server (where roots already live)
        // rather than pushing it down into the hook scripts.
        const enriched =
          event.kind === 'session_pid' && event.claude_config_dir
            ? {
                ...event,
                account_label:
                  this.accountLabels.get(event.claude_config_dir) ??
                  deriveAccountLabel(event.claude_config_dir),
              }
            : event;
        this.tracker.handleHookRecord(enriched);
        return;
      }
      if (event.kind === 'session_end') {
        this.tracker.handleHookRecord(event);
        // fall through to existing handling
      }
    }
    if (event.kind === 'stop') {
      for (const d of this.store.forceStatus(sid, 'done')) this.broadcast(d);
      // Materialize a session_summary with hook_stop provenance, but do
      // NOT flip `ended` — a parent session can take another prompt later
      // and shouldn't visually dim on Stop alone.
      this.store.recordSessionEnd(sid, 'hook_stop');
      // Stop is the strongest "turn complete" signal; bypass the debounce
      // so the titler fires immediately (if eligibility gates pass).
      this.titler.scheduleEvaluation(sid, 'stop');
      return;
    }
    if (event.kind === 'subagent_stop') {
      // Use `unendedSubagentsOf` (not `liveSubagentsOf`): a subagent that
      // already idle-transitioned to `status: 'done'` still needs its
      // `ended` flag flipped so the parent's subagent-row pin list shows
      // the ✓ glyph instead of the spinning ◐.
      for (const sub of this.store.unendedSubagentsOf(sid)) {
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
      for (const sub of this.store.unendedSubagentsOf(sid)) {
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
    // Prefer an explicitly-configured prefs.roots label; otherwise
    // derive it from the `.claude*` config-dir segment of the root so
    // multi-account setups badge every session with zero config.
    const accountLabel = sourceRoot
      ? (this.accountLabels.get(sourceRoot) ?? deriveAccountLabel(sourceRoot))
      : null;
    for (const delta of this.store.apply(event, { accountLabel })) this.broadcast(delta);
    // Out-of-band auto-titler trigger sites.
    if (event.kind === 'user_text') {
      const text = (event.payload as { text?: string }).text;
      if (isRealUserText(text)) this.titler.scheduleEvaluation(event.session_id, 'user_text');
    } else if (event.kind === 'assistant_text') {
      const text = (event.payload as { text?: string }).text;
      if (isSubstantiveAssistantText(text))
        this.titler.scheduleEvaluation(event.session_id, 'assistant_text');
    }
  }

  /** Resolve the transcript JSONL that owns a panel's events, or null if
   * it can't be found on disk. Read-only — no store/broadcast side
   * effects. Used by the `panelHistory` query for lazy scroll-back.
   *
   * Parent panels are `<root>/<encoded cwd>/<panelId>.jsonl`. Subagent
   * panel ids are the `agent-` prefix-stripped basename (see
   * `panelIdentity`), so their file is `agent-<panelId>.jsonl` under the
   * owning parent's `subagents/` dir — we try that first, then the bare
   * form for robustness. */
  sourceFileForPanel(panelId: string): string | null {
    const panel = this.store.panel(panelId);
    if (!panel) return null;
    const owner =
      panel.kind === 'parent'
        ? panel
        : panel.parent_panel_id
          ? this.store.panel(panel.parent_panel_id)
          : null;
    if (!owner?.cwd) return null;
    const encoded = encodeCwdToProjectDir(owner.cwd);
    for (const root of this.watcher.roots) {
      if (panel.kind === 'parent') {
        const candidate = path.join(root, encoded, `${panelId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      } else {
        const dir = path.join(root, encoded, owner.id, 'subagents');
        for (const name of [`agent-${panelId}.jsonl`, `${panelId}.jsonl`]) {
          const candidate = path.join(dir, name);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  /** Dev affordance: wipe a panel's in-memory + persisted state, then
   * re-read its JSONL from byte 0 so it reconstructs from the log under
   * the current set of transforms / derivation rules. Cascades to all
   * subagent panels parented to the target (and to subagent JSONLs on
   * disk that don't have a panel yet). Returns the set of file paths
   * that were queued for re-read. */
  async rebuildPanel(panelId: string): Promise<string[]> {
    const parent = this.store.panel(panelId);
    if (!parent) return [];
    if (parent.kind !== 'parent') {
      // Rebuild only makes sense from the parent — cascading from a
      // subagent would leave the parent half-rebuilt. Promote to the
      // owning parent when called on a subagent.
      const owner = parent.parent_panel_id ? this.store.panel(parent.parent_panel_id) : null;
      if (owner) return this.rebuildPanel(owner.id);
      return [];
    }
    const cwd = parent.cwd;
    // Snapshot child ids before we start mutating.
    const subagents = this.store.allSubagentsOf(panelId);
    // Resolve the file path that owns the parent panel. Try each root.
    const filesToReread: string[] = [];
    if (cwd) {
      const encoded = encodeCwdToProjectDir(cwd);
      for (const root of this.watcher.roots) {
        const candidate = path.join(root, encoded, `${panelId}.jsonl`);
        if (existsSync(candidate)) {
          filesToReread.push(candidate);
          // Discover every subagent file on disk under the same session
          // dir, even ones we don't have an in-memory panel for yet.
          const subagentDir = path.join(root, encoded, panelId, 'subagents');
          if (existsSync(subagentDir)) {
            try {
              for (const entry of await readdir(subagentDir)) {
                if (entry.endsWith('.jsonl') || entry.endsWith('.meta.json')) {
                  filesToReread.push(path.join(subagentDir, entry));
                }
              }
            } catch {
              // unreadable dir; skip
            }
          }
          break;
        }
      }
    }
    // Refuse to tear down if we can't find any JSONL to rebuild from —
    // otherwise the panel just disappears with no way to recover short
    // of a server restart.
    if (filesToReread.length === 0) return [];
    // Tear down in-memory + persisted state for the parent and every
    // child. `store.remove` broadcasts a `panel_remove` so clients
    // unmount immediately; `purgePanel` also wipes events_index /
    // session_summary / intentions.
    const tearDown = (id: string) => {
      for (const d of this.store.remove(id)) this.broadcast(d);
      this.persistStore?.purgePanel(id);
    };
    for (const sub of subagents) tearDown(sub.id);
    tearDown(panelId);
    // Re-read every queued file. processPath is async; the watcher
    // serializes via its internal `processing` chain. We `await` each
    // call so the caller knows when the rebuild has fully replayed.
    for (const file of filesToReread) {
      await this.watcher.rereadFromStart(file);
    }
    return filesToReread;
  }

  private broadcast(delta: Delta): void {
    this.emitter.emit('delta', delta);
    // When a panel announces (or upgrades) its cwd, try to load that
    // project's .hued theme. The read is async; once it lands, the store
    // emits another panel_upsert with the theme attached.
    if (delta.op === 'panel_upsert' && delta.panel.cwd && !delta.panel.theme) {
      void this.loadThemeFor(delta.panel.id, delta.panel.cwd);
    }
    // Drop any pending titler timer when a panel is reaped.
    if (delta.op === 'panel_remove') {
      this.titler.dispose(delta.panel_id);
    }
  }

  private async loadThemeFor(panelId: string, cwd: string): Promise<void> {
    const theme = await readPanelTheme(cwd);
    // Compare against the panel's current theme — `.hued` polling fires
    // every poll-interval seconds and we don't want to emit an upsert
    // delta when nothing actually changed. A null→null pass (no `.hued`
    // present, never has been) is also a no-op.
    const current = this.themeOf(panelId);
    if (themesEqual(current, theme)) return;
    for (const delta of this.store.setTheme(panelId, theme)) {
      this.emitter.emit('delta', delta);
    }
  }

  /** Look up the panel's currently-stamped theme without exposing the
   * store's private `panels` map. snapshot() returns DTOs, which carry
   * `theme`. */
  private themeOf(panelId: string): PanelTheme | null {
    for (const p of this.store.snapshot()) {
      if (p.id === panelId) return p.theme ?? null;
    }
    return null;
  }

  /** Walks every active panel and re-checks its `.hued` for changes.
   * The read is cheap when nothing changed (one stat per `.hued` path,
   * cached parse), and edits/additions/deletions surface as theme
   * deltas to all clients. Removed `.hued` clears the theme back to
   * null so the panel returns to its default tint. */
  private async pollThemes(): Promise<void> {
    const panels = this.store.snapshot();
    await Promise.all(
      panels.map((p) => (p.cwd ? this.loadThemeFor(p.id, p.cwd) : Promise.resolve())),
    );
  }
}

function themesEqual(a: PanelTheme | null, b: PanelTheme | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.background === b.background && a.foreground === b.foreground;
}
