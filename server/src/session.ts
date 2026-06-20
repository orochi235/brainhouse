/**
 * Panel state and lifecycle.
 *
 * Mirrors brainhouse/session.py. A Panel is one parent session or one subagent
 * inside it. Lifecycle is time-driven:
 *   live → done   after `idleSeconds` with no new events
 *   done → mini   after `miniSeconds` in the done state
 *   mini → removed (deleted) after `removeAfterSeconds` in mini
 *
 * Time comes from an injectable clock so tests are deterministic.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { type Event, hasTag } from './parser.js';
import type { EventIndexRow, PanelRow, SessionSummaryRow, Store } from './store.js';

/**
 * Walk up `cwd` looking for the closest `.git` directory and return that
 * ancestor's path. Used to stamp `repo_root` on a panel so widgets can
 * group every session for the same repo together, regardless of which
 * subdirectory the user ran Claude Code from.
 *
 * Cached per input so a busy directory tree doesn't re-stat on every
 * new panel. Returns `null` when no `.git` is found before the
 * filesystem root (e.g. a scratch directory, `/tmp`, etc.).
 */
const repoRootCache = new Map<string, string | null>();
export function findRepoRoot(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached;
  let cur = cwd;
  // Cap the walk so a misconfigured path can't loop indefinitely.
  for (let i = 0; i < 64; i++) {
    try {
      const git = path.join(cur, '.git');
      if (existsSync(git)) {
        // `.git` can be a dir (normal repo) or a file (worktree). Both count.
        const s = statSync(git);
        if (s.isDirectory() || s.isFile()) {
          repoRootCache.set(cwd, cur);
          return cur;
        }
      }
    } catch {
      // Permission errors or transient fs issues: just stop walking.
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  repoRootCache.set(cwd, null);
  return null;
}

export type PanelKind = 'parent' | 'subagent';
export type PanelStatus = 'live' | 'done' | 'mini';

/** Hard cap on per-panel `events.length`. Once exceeded we drop the oldest
 * `MAX_EVENTS_PER_PANEL * EVICT_FRACTION` events so trims happen in chunks
 * rather than on every push. Mostly a guardrail against a panel growing
 * unbounded when a session runs for hours — at 10k events we're already
 * well past the useful scroll-back window in the UI. */
export const MAX_EVENTS_PER_PANEL = 10_000;
const EVICT_FRACTION = 0.1;

export interface PanelTheme {
  background: string;
  foreground: string;
}

export interface Panel {
  id: string;
  kind: PanelKind;
  parent_panel_id: string | null;
  title: string;
  /** For subagents: the agentType from `.meta.json` (Explore, general-purpose,
   * Plan, …). Used as the panel's small subtitle so the title can be the
   * task description itself instead of `agentType: description`. */
  agent_type: string | null;
  /** For subagents: the original task description from `.meta.json`,
   * captured once and never overwritten. Lets a parent panel join its
   * `Task` tool_use entries to live child panels even after auto-title
   * may have replaced the title. */
  task_description: string | null;
  /** Optional account label (from prefs.roots[].label) identifying which
   * Claude config root owns this session. Client renders a small badge when
   * more than one account is configured. */
  account_label: string | null;
  status: PanelStatus;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  cwd: string | null;
  /** Filesystem path of the repo this panel's `cwd` belongs to — the
   * closest ancestor of `cwd` containing a `.git`. Stamped once at panel
   * creation by `findRepoRoot()`. The widgets layer groups sessions by
   * `repo_root` so a session run from `~/src/foo/client` clusters with
   * one run from `~/src/foo`. `null` for scratch dirs / non-repo cwds —
   * those still produce a widget keyed by the cwd's last segment. */
  repo_root: string | null;
  theme: PanelTheme | null;
  events: Event[];
  /** Soft-delete timestamp. Non-null = the panel is in the trash bin: it
   * doesn't appear in the main snapshot or progress through lifecycle
   * states, but the data is retained until an explicit purge. */
  binned_at: number | null;
  /** True when Claude Code has fired a Notification hook for this session
   * — typically "permission required" or "input requested". Cleared on the
   * next event ingest. Surfaced via panel_upsert so clients can render a
   * "blocking on you" badge. */
  awaiting_input: boolean;
  /** True when we have an *explicit* confirmation that the session is over
   * (e.g. SubagentStop hook fired). Distinct from `status: 'done'`, which
   * just means "went idle"; a parent session can sit idle for minutes and
   * still take another prompt. Only `ended` panels get visually dimmed. */
  ended: boolean;
  /** When ended=true, how we learned. Null otherwise. */
  ended_provenance:
    | 'hook_stop'
    | 'hook_subagent_stop'
    | 'hook_session_end'
    | 'hook_session_start_supersede'
    | 'idle_timeout'
    | 'server_close'
    | 'progress_complete'
    | 'bootstrap_stale'
    | null;
  /** Running token counters, accumulated from `resource_usage` events.
   * `model` is the last model_id seen on a usage record (sessions can
   * span model changes but the most recent dominates display). */
  tokens: {
    input: number;
    output: number;
    cache_create: number;
    cache_read: number;
    model: string | null;
  };
  /** Size of the current context window — `input + cache_create + cache_read`
   * from the most recent assistant turn's usage record. Unlike `tokens` (which
   * accumulates lifetime usage), this is overwritten on every turn and reflects
   * what's actively in context right now. Zero until first usage record. */
  context_size: number;
  /** Cumulative estimated tokens of context injected by brainhouse hooks
   * (UserPromptSubmit `additionalContext`, SessionStart `additionalContext`
   * / `initialUserMessage`). Reported by each hook via a `hook_overhead`
   * side-channel record using a ~4-chars-per-token proxy. Lets the UI
   * show "instrumentation overhead" against the live context_size. Not
   * persisted across server restarts — re-accumulates from the JSONL. */
  hook_overhead_tokens: number;
  /** When set, this panel was just started via `/clear` and we want to
   * suppress the *inherited* custom title that Claude Code re-emits into
   * the fresh transcript. The first `custom-title` meta we see records
   * its text here; identical subsequent records are dropped. The user's
   * first real `user_text` post-/clear clears this. An explicit
   * `/rename` to a *different* string is honored immediately and also
   * clears the suppression. */
  clear_title_suppression: { suppressed_title: string | null } | null;
  /** True once the user has explicitly set this panel's title via
   * `/rename` (a `custom-title` meta record that wasn't a /clear
   * inheritance echo). Stays true for the panel's lifetime — the auto-
   * title path doesn't unset it, and rehydrate restores it from the
   * persisted panels row. UI uses this to render a small "manual title"
   * glyph next to the title so a user-authored name is visually
   * distinct from an auto-derived one. */
  manually_renamed: boolean;
}

export interface PanelDto {
  id: string;
  kind: PanelKind;
  parent_panel_id: string | null;
  title: string;
  agent_type: string | null;
  task_description: string | null;
  account_label: string | null;
  status: PanelStatus;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  event_count: number;
  cwd: string | null;
  /** Repo root inferred from `cwd` (closest `.git` ancestor). See
   * `Panel.repo_root`. Null for non-repo cwds. */
  repo_root: string | null;
  theme: PanelTheme | null;
  binned_at: number | null;
  awaiting_input: boolean;
  ended: boolean;
  ended_provenance: Panel['ended_provenance'];
  /** True if the title was explicitly set via `/rename`. See
   * `Panel.manually_renamed` for the lifetime + UI contract. */
  manually_renamed: boolean;
  tokens: {
    input: number;
    output: number;
    cache_create: number;
    cache_read: number;
    model: string | null;
  };
  context_size: number;
  hook_overhead_tokens: number;
}

export type Delta =
  /** `events` is included on dock-restore (unbin) so the client can
   * repopulate the panel's history in one shot — the snapshot path that
   * normally seeds events skips binned panels. All other upsert emitters
   * omit it and the client preserves any events it already has. */
  | { op: 'panel_upsert'; panel: PanelDto; events?: Event[] }
  | { op: 'panel_status'; panel_id: string; status: PanelStatus }
  | { op: 'panel_remove'; panel_id: string }
  | { op: 'event_append'; panel_id: string; event: Event }
  /** Transient: drives the title flash + toast on the client when the
   * auto-title hook proposes a new name. Not persisted, not part of
   * panel state — it's a one-shot UX cue. */
  | { op: 'auto_titled'; panel_id: string; prev_title: string; new_title: string };

export interface SessionStoreOptions {
  idleSeconds?: number;
  miniSeconds?: number;
  removeAfterSeconds?: number;
  clock?: () => number;
  /** Optional persistence layer. When set, panel state mirrors into the
   * `panels` table on every transition, events go into `events_index`,
   * and `session_summary` rows are materialized on end-of-session. */
  store?: Store | null;
  /** Liveness oracle: given a session id, returns whether its owning
   * `claude` process is still alive (per the ProcessTracker). Used to
   * suppress the idle→done transition for sessions that are still working
   * but haven't flushed a transcript record recently — long agentic turns
   * write in bursts, so transcript-idle ≠ session-done. Defaults to
   * "always dead", preserving the pure transcript-idle behavior when no
   * tracker is wired (tests, persistence-only hosts). */
  isSessionLive?: (sessionId: string) => boolean;
  /** Surfacing window for `snapshot()`. A panel whose owning process is not
   * live surfaces to the UI only if it was active within this many seconds.
   * Older panels stay in memory (queryable, lifecycle intact) but are not
   * surfaced through the snapshot/hello chokepoint. Defaults to 48h. */
  uiWindowSeconds?: number;
}

export class SessionStore {
  idleSeconds: number;
  miniSeconds: number;
  removeAfterSeconds: number;
  private readonly clock: () => number;
  private readonly panels = new Map<string, Panel>();
  private readonly store: Store | null;
  private readonly isSessionLive: (sessionId: string) => boolean;
  private readonly uiWindowSeconds: number;
  /** Session ids that started via `/clear` whose panel hasn't been
   * created yet. Drained at `ensurePanel` time to arm
   * `panel.clear_title_suppression`. SessionStart hook events typically
   * land before the first JSONL record for the new session, so the
   * panel does not yet exist when supersede fires. */
  private readonly pendingClearTitleSuppression = new Set<string>();
  /** Owner panel ids the user has explicitly kept alive (restored from the
   * dock or reopened from history). They bypass the {@link uiWindowSeconds}
   * surfacing gate so a kept/reopened session survives a reload instead of
   * being silently re-hidden once it ages out of the window. Seeded from the
   * persisted `user_kept` intentions on {@link hydrate} and kept in sync via
   * {@link setForceSurfaced}. */
  private readonly forceSurfaced = new Set<string>();

  constructor(opts: SessionStoreOptions = {}) {
    this.idleSeconds = opts.idleSeconds ?? 60;
    this.miniSeconds = opts.miniSeconds ?? 5 * 60;
    this.removeAfterSeconds = opts.removeAfterSeconds ?? 24 * 60 * 60;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.store = opts.store ?? null;
    this.isSessionLive = opts.isSessionLive ?? (() => false);
    this.uiWindowSeconds = opts.uiWindowSeconds ?? 172800;
  }

  /** Hydrate the in-memory panel map from the persistence store. Call
   * before any apply() / tick() so the bootstrap watcher pass operates
   * on top of the last-known state instead of starting fresh. Events
   * are not rehydrated — they remain in the JSONL files on disk and
   * the watcher fills them back in from bootstrap_offsets. */
  hydrate(): void {
    if (!this.store) return;
    for (const row of this.store.allPanels()) {
      this.panels.set(row.id, panelRowToPanel(row));
    }
    // Re-seed the force-surface allowlist so kept/reopened sessions survive
    // the window gate across restarts (see {@link forceSurfaced}).
    for (const intent of this.store.allIntentions()) {
      if (intent.user_kept) this.forceSurfaced.add(intent.panel_id);
    }
  }

  /** Add or remove a panel from the force-surface allowlist. Called when the
   * user keeps/restores a panel or reopens a session (add), and when they
   * dismiss it again (remove). Idempotent. */
  setForceSurfaced(panelId: string, on: boolean): void {
    if (on) this.forceSurfaced.add(panelId);
    else this.forceSurfaced.delete(panelId);
  }

  /** Hot-swap lifecycle timings. The next `tick()` immediately respects
   * the new values — panels that newly satisfy a transition fire on the
   * next tick rather than retroactively. */
  setTimings(opts: { idleSeconds?: number; miniSeconds?: number; removeAfterSeconds?: number }) {
    if (opts.idleSeconds !== undefined) this.idleSeconds = opts.idleSeconds;
    if (opts.miniSeconds !== undefined) this.miniSeconds = opts.miniSeconds;
    if (opts.removeAfterSeconds !== undefined) this.removeAfterSeconds = opts.removeAfterSeconds;
  }

  apply(event: Event, opts: { accountLabel?: string | null } = {}): Delta[] {
    const now = this.clock();
    const deltas: Delta[] = [];
    // Resolve the event's timestamp first so a brand-new panel seeded by a
    // bootstrap-replay starts with the event's own time, not "now". Cap at
    // `now` so a clock-skewed transcript can't project into the future.
    const eventTs = parseEventTs(event.ts);
    const ts = eventTs !== null ? Math.min(eventTs, now) : now;
    const panel = this.ensurePanel(event, now, ts, deltas, opts.accountLabel ?? null);
    // Dedupe by uuid. The watcher re-reads `.meta.json` sidecars on every
    // change event and emits with a stable `agent-X:meta` uuid; without this
    // guard those duplicates pile up in `panel.events` and React's list
    // renderer complains about non-unique keys.
    if (panel.events.some((e) => e.uuid === event.uuid)) return deltas;
    // Sidechannel: resource_usage isn't user-facing transcript content; it
    // updates panel totals and a panel_upsert delta carries the new
    // numbers to clients. Don't push it onto panel.events (would clutter
    // the dedupe set + bloat the event list for no UI benefit).
    if (event.kind === 'resource_usage') {
      const prevContext = panel.context_size;
      const changed = accumulateUsage(panel, event.payload);
      panel.last_event_at = Math.max(panel.last_event_at, ts);
      // Skip the upsert when nothing visible changed (e.g. an empty usage
      // record). context_size is overwritten per-turn, so we treat any
      // delta there as meaningful.
      if (changed || panel.context_size !== prevContext) {
        deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
      }
      this.persistPanel(panel);
      this.persistEvent(panel, event, ts);
      return deltas;
    }
    panel.events.push(event);
    // Cap event history per panel — oldest entries lose first.
    if (panel.events.length > MAX_EVENTS_PER_PANEL) {
      panel.events.splice(0, Math.ceil(MAX_EVENTS_PER_PANEL * EVICT_FRACTION));
    }
    // Meta records are sidechannel (subagent-meta sidecars, custom-title
    // re-emits on terminal close, etc.); they're not user-visible activity.
    // Treating them as activity bumps last_event_at to wall-clock-now and
    // makes the panel's idle / +X timers read 0 after a server restart.
    if (event.kind !== 'meta') {
      panel.last_event_at = Math.max(panel.last_event_at, ts);
    }
    // Clear awaiting-input on any new activity (it's a transient blocker
    // flag). Do NOT clear `ended` — terminal close-out flushes, late
    // tool_result echoes, and other death-rattle writes shouldn't undo
    // an authoritative end signal (Stop hook, SubagentStop, checklist
    // completion). Ended panels still get the event appended for audit,
    // but stay dimmed instead of bouncing back to live.
    if (panel.awaiting_input) {
      panel.awaiting_input = false;
      deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    }
    // Meta records are sidecar updates (title, last-prompt, permission-mode,
    // subagent-meta, …), not session activity. Terminal-close flushes a
    // batch of these long after the session went idle; treating them as
    // activity resurrects done/mini panels. Real activity comes through as
    // user_text/assistant_text/tool_use/etc.
    if (!panel.ended && !hasTag(event, 'meta')) {
      const owner = panel.kind === 'subagent' ? (panel.parent_panel_id ?? panel.id) : panel.id;
      if (this.isLiveActivity(owner, ts, now)) {
        if (panel.status !== 'live') {
          panel.status = 'live';
          panel.status_changed_at = panel.last_event_at;
          deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'live' });
        }
      } else if (panel.status !== 'live') {
        // Stale event — a cold-start replay catch-up, not real activity. Settle
        // straight to the age-appropriate status instead of flashing `live`,
        // which would claim a full-size grid slot and produce the restart
        // "god view" of dozens of full panels. (A panel already promoted to
        // `live` by a fresher event in the same replay batch is left alone — a
        // later stale straggler shouldn't demote it; the tick handles that.)
        const settled = this.settledState(panel.last_event_at, now);
        if (panel.status !== settled.status) {
          panel.status = settled.status;
          deltas.push({ op: 'panel_status', panel_id: panel.id, status: settled.status });
        }
        panel.status_changed_at = settled.changed_at;
      }
    }
    const titleBefore = panel.title;
    this.maybeUpdateTitle(panel, event, deltas);
    this.maybeJoinSubagentTitle(panel, event, deltas);
    this.maybeAdoptCwd(panel, event, deltas);
    deltas.push({ op: 'event_append', panel_id: panel.id, event });
    // Auto-title proposals from in-band events (substantive follow-up
    // prompts, agent-emitted `session-title` meta). Skipped on the same
    // event that just set the first-prompt title, since that already
    // happened silently above. applyAutoTitle dedupes when the proposal
    // matches the current title.
    const proposed = this.maybeProposeAutoTitle(panel, event, titleBefore);
    if (proposed) {
      for (const d of this.applyAutoTitle(panel.id, proposed)) deltas.push(d);
    }
    this.persistEvent(panel, event, ts);
    this.persistPanel(panel);
    // Subagent finality by checklist: when a subagent's pinned
    // brainhouse-checklist hits 100% completion in a freshly-ingested
    // bubble, treat it as an explicit end. Mirrors the client-side
    // sweep so a refresh doesn't resurrect the panel.
    if (panel.kind === 'subagent' && !panel.ended && isChecklistComplete(event)) {
      for (const d of this.markEnded(panel.id, 'progress_complete')) deltas.push(d);
    }
    return deltas;
  }

  /** Build a session_summary row for a fully-parsed transcript without
   * surfacing it as a live panel. Intended to run on a *throwaway*
   * SessionStore (store=null) so the apply() mutations and discarded deltas
   * never reach a live subscriber. Returns null if the events produced no
   * parent panel. */
  summarizeOffline(events: Event[]): SessionSummaryRow | null {
    let sessionId: string | null = null;
    for (const event of events) {
      this.apply(event); // deltas discarded; this.store is null on throwaway
      if (!event.agent_id) sessionId = event.session_id;
    }
    if (!sessionId) return null;
    const panel = this.panels.get(sessionId);
    if (!panel) return null;
    // 'never' = we did not observe this session ending; indexed retroactively
    // from a complete-on-disk transcript.
    return buildSessionSummary(panel, 'never', this.clock());
  }

  /** Stamp the panel's theme. Called by the monitor once .hued has been read. */
  setTheme(panelId: string, theme: PanelTheme | null): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel) return [];
    panel.theme = theme;
    this.persistPanel(panel);
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  tick(now?: number): Delta[] {
    const t = now ?? this.clock();
    const deltas: Delta[] = [];
    const toRemove: Panel[] = [];
    for (const panel of this.panels.values()) {
      // Binned panels are frozen — no auto live→done→mini→removed progression.
      if (panel.binned_at !== null) continue;
      // Process-aware liveness: a session whose `claude` process is still
      // alive is still working even when the transcript has been quiet past
      // idleSeconds (long agentic turns flush records in bursts). Subagents
      // inherit the owning session's process. Hold `live` until the process
      // actually exits, after which this same guard lets it flip.
      const ownerSid = panel.kind === 'subagent' ? (panel.parent_panel_id ?? panel.id) : panel.id;
      if (
        panel.status === 'live' &&
        t - panel.last_event_at >= this.idleSeconds &&
        !this.isSessionLive(ownerSid)
      ) {
        panel.status = 'done';
        // Stamp when the panel *actually* went idle so a bootstrap-replayed
        // session shows "done 2h ago" instead of "done 0s ago".
        panel.status_changed_at = Math.min(t, panel.last_event_at + this.idleSeconds);
        deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'done' });
        this.persistPanel(panel);
        // Materialize the session summary on the live→done transition so
        // it's available in SQLite as soon as the session goes idle — even
        // though the panel might come back to live later (in which case
        // we overwrite the row on the next transition).
        this.materializeSummary(panel, 'idle_timeout');
      } else if (panel.status === 'done' && t - panel.status_changed_at >= this.miniSeconds) {
        panel.status = 'mini';
        panel.status_changed_at = Math.min(t, panel.status_changed_at + this.miniSeconds);
        deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'mini' });
        this.persistPanel(panel);
      } else if (
        panel.status === 'mini' &&
        panel.ended &&
        t - panel.status_changed_at >= this.removeAfterSeconds
      ) {
        // Only ended panels are reap-eligible. A still-alive session
        // (Claude Code process running, no /clear, no Stop hook) lingers
        // in mini indefinitely so it stays trackable across the day.
        // Don't reap a parent that still has non-ended subagents (docked or
        // detached). Subagents can outlive their parent's own activity, and
        // removing the container would orphan the placeholder in the tray
        // or kill docked children silently. Wait until all children end.
        if (panel.kind === 'parent' && this.hasLiveSubagents(panel.id)) continue;
        toRemove.push(panel);
      }
    }
    for (const panel of toRemove) {
      // Last-chance materialize before the panel is forgotten; covers the
      // case where it aged all the way out without ever flipping ended.
      this.materializeSummary(panel, panel.ended ? (panel.ended_provenance ?? 'never') : 'never');
      this.panels.delete(panel.id);
      this.store?.deletePanel(panel.id);
      deltas.push({ op: 'panel_remove', panel_id: panel.id });
    }
    return deltas;
  }

  /** Soft-delete: move to the trash bin. The panel data is retained;
   * clients see a panel_remove and drop it from their view. Restorable
   * via `unbin()`. */
  bin(panelId: string): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel || panel.binned_at !== null) return [];
    panel.binned_at = this.clock();
    this.persistPanel(panel);
    return [{ op: 'panel_remove', panel_id: panelId }];
  }

  /** Reverse `bin()`. Emits a panel_upsert so clients re-mount it. */
  unbin(panelId: string): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel || panel.binned_at === null) return [];
    panel.binned_at = null;
    // Refresh the lifecycle timer so an old binned panel doesn't immediately
    // get demoted by the next tick.
    panel.status_changed_at = this.clock();
    this.persistPanel(panel);
    // Carry events in the upsert: while binned, the panel was excluded
    // from `snapshot()`, so any client that connected during the binned
    // window has zero events for it. Without this the restored panel
    // renders as an empty div.
    return [{ op: 'panel_upsert', panel: this.toDto(panel), events: panel.events.slice() }];
  }

  /** Permanent removal. Used by the trash-bin "purge" button or the
   * lifecycle auto-removal for unbinned panels. */
  remove(panelId: string): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel) return [];
    this.panels.delete(panelId);
    this.store?.deletePanel(panelId);
    return [{ op: 'panel_remove', panel_id: panelId }];
  }

  /** List binned panel DTOs for the trash UI. Returned without their event
   * arrays — the bin viewer just shows titles + binned_at. */
  binnedDtos(): PanelDto[] {
    return Array.from(this.panels.values())
      .filter((p) => p.binned_at !== null)
      .map((p) => this.toDto(p));
  }

  forceStatus(panelId: string, status: PanelStatus): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel || panel.status === status) return [];
    const now = this.clock();
    panel.status = status;
    panel.status_changed_at = now;
    if (status === 'live') panel.last_event_at = now;
    this.persistPanel(panel);
    return [{ op: 'panel_status', panel_id: panelId, status }];
  }

  /** Toggle the "this panel is blocking on user input" flag. Emits an upsert
   * delta when the value actually changes. Cleared automatically on next
   * ingested event. */
  setAwaiting(panelId: string, awaiting: boolean): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel || panel.awaiting_input === awaiting) return [];
    panel.awaiting_input = awaiting;
    this.persistPanel(panel);
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  /** Used by tick()'s reap gate: a parent with any non-ended subagent
   * stays alive past `removeAfterSeconds`, since the subagent could outlive
   * the parent's own activity (e.g. a detached subagent still working). */
  private hasLiveSubagents(parentId: string): boolean {
    for (const p of this.panels.values()) {
      if (p.kind === 'subagent' && p.parent_panel_id === parentId && !p.ended) return true;
    }
    return false;
  }

  /** Subagent panels (live or done) parented to a given session. Used by
   * SubagentStop to find which subagent to demote — Claude Code's hook
   * payload doesn't directly identify the subagent id, so we collapse all
   * live ones under the parent. */
  /** Every subagent panel (live, done, ended — doesn't matter) parented
   * to the given session. Used by the dev "rebuild from log" affordance
   * to cascade the teardown. */
  allSubagentsOf(parentSessionId: string): Panel[] {
    return Array.from(this.panels.values()).filter(
      (p) => p.kind === 'subagent' && p.parent_panel_id === parentSessionId,
    );
  }

  liveSubagentsOf(parentSessionId: string): Panel[] {
    return Array.from(this.panels.values()).filter(
      (p) => p.kind === 'subagent' && p.parent_panel_id === parentSessionId && p.status === 'live',
    );
  }

  /** Like `liveSubagentsOf` but also matches subagents whose status has
   * idled to `done` / `mini` while they were never explicitly ended.
   * Used by SubagentStop / session_end / supersede paths: those are
   * authoritative end signals and should flip `ended` even on subagents
   * that already left `status: 'live'` via the idle timer. */
  unendedSubagentsOf(parentSessionId: string): Panel[] {
    return Array.from(this.panels.values()).filter(
      (p) => p.kind === 'subagent' && p.parent_panel_id === parentSessionId && !p.ended,
    );
  }

  /** Find the parent panel most likely to have been superseded by a brand-new
   * SessionStart with source=clear/compact.
   *
   * Narrowing:
   *   - not already ended (don't re-end something we've already retired)
   *   - kind=parent (subagents inherit ended via the parent's transitions)
   *   - Claude Code's encoding of panel.cwd matches `encodedCwdDir` — i.e.
   *     the prior panel and the new session live under the same
   *     `<projectsDir>/<encoded-cwd>/` (so a `/clear` in project A can't end
   *     a panel still active in project B opened from a different terminal)
   *   - panel.id ≠ `excludeId` (don't end the new session itself, if it has
   *     already been observed)
   *   - last_event_at within `withinSeconds` (a `/clear` immediately follows
   *     real activity — a panel idle for hours in the same cwd is much more
   *     likely a different terminal that's still around)
   *   - last_event_at OLDER than `minIdleSeconds` (a panel that emitted an
   *     event in the last beat is probably an actively-responding session
   *     in another terminal — the prior session being cleared stopped
   *     emitting events at least a moment before the new SessionStart
   *     fired). Defaults to 0 (no floor) when the caller doesn't set it.
   *
   * Returns the single best candidate (most recent last_event_at) or null. */
  findSupersedablePanel(opts: {
    encodedCwdDir: string;
    excludeId: string;
    now: number;
    withinSeconds: number;
    minIdleSeconds?: number;
  }): Panel | null {
    const floor = opts.now - opts.withinSeconds;
    const ceil = opts.now - (opts.minIdleSeconds ?? 0);
    let best: Panel | null = null;
    for (const p of this.panels.values()) {
      if (p.kind !== 'parent') continue;
      if (p.ended) continue;
      if (p.binned_at !== null) continue;
      if (p.id === opts.excludeId) continue;
      if (!p.cwd) continue;
      if (encodeCwdToProjectDir(p.cwd) !== opts.encodedCwdDir) continue;
      if (p.last_event_at < floor) continue;
      if (p.last_event_at > ceil) continue;
      if (!best || p.last_event_at > best.last_event_at) best = p;
    }
    return best;
  }

  snapshot(): Array<PanelDto & { events: Event[] }> {
    const now = this.clock();
    const cutoff = now - this.uiWindowSeconds;
    return Array.from(this.panels.values())
      .filter((p) => p.binned_at === null && this.isSurfaceable(p, cutoff))
      .map((p) => ({
        ...this.toDto(p),
        events: p.events.slice(),
      }));
  }

  /** A panel surfaces as a live UI panel iff its owning process is alive, or
   * it has been active within the UI window. An out-of-window panel is never
   * surfaced (a stale persisted row must not leak in). */
  private isSurfaceable(p: Panel, cutoff: number): boolean {
    const owner = p.kind === 'subagent' ? (p.parent_panel_id ?? p.id) : p.id;
    if (this.isSessionLive(owner)) return true;
    // A user-kept/reopened owner (and its subagents) bypasses the window gate.
    if (this.forceSurfaced.has(owner)) return true;
    return p.last_event_at >= cutoff;
  }

  /** Unfiltered dump of every panel in the map (including binned) with
   * debug-relevant fields. Used by the `/debug` tile to expose the model
   * state independent of any rendering filters. Not part of the normal
   * delta-stream contract — do not consume this from production UI. */
  debugDump(): Array<{
    id: string;
    kind: PanelKind;
    parent_panel_id: string | null;
    title: string;
    status: PanelStatus;
    binned_at: number | null;
    ended: boolean;
    awaiting_input: boolean;
    started_at: number;
    last_event_at: number;
    status_changed_at: number;
    cwd: string | null;
    account_label: string | null;
    agent_type: string | null;
    task_description: string | null;
    event_count: number;
  }> {
    return Array.from(this.panels.values()).map((p) => ({
      id: p.id,
      kind: p.kind,
      parent_panel_id: p.parent_panel_id,
      title: p.title,
      status: p.status,
      binned_at: p.binned_at,
      ended: p.ended,
      awaiting_input: p.awaiting_input,
      started_at: p.started_at,
      last_event_at: p.last_event_at,
      status_changed_at: p.status_changed_at,
      cwd: p.cwd,
      account_label: p.account_label,
      agent_type: p.agent_type,
      task_description: p.task_description,
      event_count: p.events.length,
    }));
  }

  panel(panelId: string): Panel | undefined {
    return this.panels.get(panelId);
  }

  /** True if a (non-binned) panel for this id is currently surfaced-eligible
   * in memory. Used to short-circuit on-demand reopen for an already-live id. */
  snapshotHas(id: string): boolean {
    const p = this.panels.get(id);
    return !!p && p.binned_at === null;
  }

  /** Look up a single event by uuid within a panel's in-memory window
   * (capped well above the client's live window). Returns null if the panel
   * or event isn't resident. No JSONL re-scan — events evicted past the
   * server cap are unavailable. */
  eventByUuid(panelId: string, uuid: string): Event | null {
    const panel = this.panels.get(panelId);
    if (!panel) return null;
    return panel.events.find((e) => e.uuid === uuid) ?? null;
  }

  /** Whether an event represents genuine live activity (so its panel should
   * surface `live`) rather than a stale cold-start replay catch-up. A session
   * whose owning process is alive is always live; otherwise the event must be
   * recent (within `idleSeconds`). `ts` is the event's clamped timestamp. */
  private isLiveActivity(ownerId: string, ts: number, now: number): boolean {
    return this.isSessionLive(ownerId) || now - ts < this.idleSeconds;
  }

  /** The status + `status_changed_at` a non-live panel should hold given how
   * long ago its last event was, mirroring the live→done→mini thresholds.
   * Lets a cold-start replay land a session exactly where the lifecycle would
   * have put it, with no transient `live` flash. `changed_at` is back-dated to
   * the moment the panel would have entered that state so the subsequent
   * done→mini / mini→remove tick timing stays correct. */
  private settledState(lastEventAt: number, now: number): {
    status: 'done' | 'mini';
    changed_at: number;
  } {
    const doneAt = lastEventAt + this.idleSeconds;
    const miniAt = doneAt + this.miniSeconds;
    if (now >= miniAt) return { status: 'mini', changed_at: miniAt };
    return { status: 'done', changed_at: doneAt };
  }

  private ensurePanel(
    event: Event,
    now: number,
    eventTs: number,
    deltas: Delta[],
    accountLabel: string | null,
  ): Panel {
    const { id, kind, parent_panel_id } = panelIdentity(event);
    const existing = this.panels.get(id);
    if (existing) return existing;
    // A brand-new panel seeded by a cold-start replay of an old transcript
    // settles straight to its age-appropriate status rather than defaulting to
    // `live` (see {@link settledState} / {@link isLiveActivity}).
    const owner = kind === 'subagent' ? (parent_panel_id ?? id) : id;
    const settled = this.isLiveActivity(owner, eventTs, now)
      ? null
      : this.settledState(eventTs, now);
    const panel: Panel = {
      id,
      kind,
      parent_panel_id,
      title: initialTitle(id, kind),
      agent_type: null,
      task_description: null,
      account_label: accountLabel,
      binned_at: null,
      awaiting_input: false,
      ended: false,
      ended_provenance: null,
      manually_renamed: false,
      tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
      context_size: 0,
      hook_overhead_tokens: 0,
      clear_title_suppression: this.pendingClearTitleSuppression.delete(id)
        ? { suppressed_title: null }
        : null,
      status: settled ? settled.status : 'live',
      // started_at gets the event's ts so a bootstrap-replayed old session
      // reflects its real age, not wall-clock-now-of-restart. The first
      // event we see is typically a SessionStart or the first user_text,
      // both of which sit at the head of the JSONL. last_event_at and
      // status_changed_at also pick up the event ts so bootstrap-replay
      // shows the right "X ago" for the idle / status-change displays.
      started_at: eventTs,
      last_event_at: eventTs,
      status_changed_at: settled ? settled.changed_at : eventTs,
      cwd: event.cwd,
      repo_root: findRepoRoot(event.cwd),
      theme: null,
      events: [],
    };
    this.panels.set(id, panel);
    deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    return panel;
  }

  /** Late-arriving cwd: most records have it but some metadata ones don't.
   * Adopt the first non-null cwd we see and emit a panel_upsert. */
  private maybeAdoptCwd(panel: Panel, event: Event, deltas: Delta[]): void {
    if (panel.cwd) return;
    if (!event.cwd) return;
    panel.cwd = event.cwd;
    panel.repo_root = findRepoRoot(event.cwd);
    deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
  }

  private maybeUpdateTitle(panel: Panel, event: Event, deltas: Delta[]): void {
    // The first real user_text on a /clear'd session signals the user's
    // first prompt post-clear. Any inherited-title suppression ends here
    // — subsequent custom-title records (auto-emitted or explicit) flow
    // normally. Slash-command artifacts (`<command-name>` etc.) are not
    // real prompts; ignore them here too.
    if (panel.clear_title_suppression && event.kind === 'user_text') {
      const t = (event.payload.text ?? '').trim();
      if (t && !/^<(local-command-(caveat|stdout)|command-(name|message|args))>/.test(t)) {
        panel.clear_title_suppression = null;
      }
    }
    let title = panel.title;
    // Explicit /rename — always wins, regardless of panel kind or current title.
    if (event.kind === 'meta' && event.payload.record_type === 'custom-title') {
      const raw = (event.payload.raw ?? {}) as { customTitle?: string };
      const custom = (raw.customTitle ?? '').trim();
      // /clear suppression: Claude Code re-emits the prior session's
      // custom-title into the fresh transcript. The first one we see we
      // remember; identical subsequent ones are dropped. A *different*
      // customTitle is treated as an explicit /rename — honored, and the
      // suppression clears.
      if (panel.clear_title_suppression) {
        const supp = panel.clear_title_suppression;
        if (supp.suppressed_title === null) {
          supp.suppressed_title = custom;
          return;
        }
        if (custom === supp.suppressed_title) return;
        panel.clear_title_suppression = null;
      }
      if (custom) {
        title = custom.length > 80 ? `${custom.slice(0, 79)}…` : custom;
        // The user is the only source of a non-suppressed custom-title:
        // /rename, /title, or a SessionStart sourced from a transcript
        // they had previously /rename'd. Flag the panel as manually
        // titled so the UI can mark it. We don't clear this on
        // subsequent auto-title runs — once authored, always authored.
        panel.manually_renamed = true;
      }
    } else if (panel.kind === 'subagent') {
      if (event.kind !== 'meta') return;
      if (event.payload.record_type !== 'subagent-meta') return;
      const raw = (event.payload.raw ?? {}) as { agentType?: string; description?: string };
      const agentType = (raw.agentType ?? '').trim();
      const description = (raw.description ?? '').trim();
      // Record agentType for the subtitle, even if there's no description yet.
      if (agentType && panel.agent_type !== agentType) {
        panel.agent_type = agentType;
        deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
      }
      // Capture the original task description once; never overwrite. The
      // parent panel uses this to join its `Task` tool_use entries to live
      // child panels even if auto-title later changes `panel.title`.
      if (description && panel.task_description === null) {
        panel.task_description = description;
      }
      // Title is the task description; agentType lives in the subtitle.
      if (description)
        title = description.length > 80 ? `${description.slice(0, 79)}…` : description;
      else if (agentType) title = agentType;
    } else {
      // Parent panel: derive title from the first user message we see, but
      // only while the title is still the default short-id placeholder so a
      // late-arriving meta record can't clobber a good title.
      if (panel.title !== initialTitle(panel.id, 'parent')) return;
      if (event.kind !== 'user_text') return;
      const text = (event.payload.text ?? '').trim();
      if (!text) return;
      // Skip the `/clear` (and other slash-command) artifact messages —
      // caveat, command-name, command-message, command-args, stdout. They
      // arrive before the user's first real prompt and would otherwise
      // become the panel title.
      if (hasTag(event, 'artifact')) return;
      const firstLine =
        text
          .split('\n')
          .find((l) => l.trim() !== '')
          ?.trim() ?? '';
      if (!firstLine) return;
      title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
    }
    if (title && title !== panel.title) {
      panel.title = title;
      deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    }
  }

  /** Recover a subagent's title from the parent's spawning `Task` tool_use
   * when the subagent has no `.meta.json` of its own (older spawns leave
   * the panel stuck on the `subagent · <id>` placeholder). The Task call's
   * `input.description` is the same string the harness writes into the meta
   * sidecar, and `subagent_type` feeds the agent-type subtitle — so this is
   * a pure fallback for the same data, joined on the `source_tool_use_id`
   * the subagent's first message carries. Runs in both directions so it
   * resolves regardless of whether the parent's Task event or the child
   * panel is observed first. */
  private maybeJoinSubagentTitle(panel: Panel, event: Event, deltas: Delta[]): void {
    // Direction 1: the subagent's first message reveals which Task spawned
    // it; resolve against the parent (whose Task event is usually already in).
    if (panel.kind === 'subagent' && event.kind === 'user_text') {
      const src = event.payload.source_tool_use_id;
      if (src) this.applyParentTaskTitle(panel, src, deltas);
      return;
    }
    // Direction 2: a parent's Task tool_use lands after the child panel —
    // title any of this parent's subagents waiting on this tool_use_id.
    if (event.kind === 'tool_use' && event.payload.name === 'Task') {
      const tuid = event.payload.tool_use_id;
      if (!tuid) return;
      for (const child of this.panels.values()) {
        if (child.kind !== 'subagent' || child.parent_panel_id !== panel.id) continue;
        if (subagentSpawnToolUseId(child) === tuid) {
          this.applyParentTaskTitle(child, tuid, deltas);
        }
      }
    }
  }

  /** Title a subagent panel from the parent `Task` tool_use identified by
   * `toolUseId`. No-op unless the lookup succeeds and the panel's title is
   * still weak (the placeholder or a bare agent-type) and not manually
   * renamed — the subagent's own meta, when present, always wins (and
   * carries the same description anyway). */
  private applyParentTaskTitle(panel: Panel, toolUseId: string, deltas: Delta[]): void {
    if (panel.manually_renamed || panel.parent_panel_id === null) return;
    const placeholder = initialTitle(panel.id, 'subagent');
    const titleIsWeak =
      panel.title === placeholder ||
      (panel.agent_type !== null && panel.title === panel.agent_type);
    // Already fully resolved (real title + known agent type): nothing to do.
    if (!titleIsWeak && panel.agent_type !== null) return;
    const parent = this.panels.get(panel.parent_panel_id);
    if (!parent) return;
    const task = parent.events.find(
      (e): e is Extract<Event, { kind: 'tool_use' }> =>
        e.kind === 'tool_use' &&
        e.payload.name === 'Task' &&
        e.payload.tool_use_id === toolUseId,
    );
    if (!task) return;
    const input = (task.payload.input ?? {}) as { description?: string; subagent_type?: string };
    const description = (input.description ?? '').trim();
    const subagentType = (input.subagent_type ?? '').trim();
    let changed = false;
    if (subagentType && panel.agent_type === null) {
      panel.agent_type = subagentType;
      changed = true;
    }
    if (description && panel.task_description === null) {
      panel.task_description = description;
    }
    const best = description || subagentType;
    if (best && titleIsWeak) {
      const next = best.length > 80 ? `${best.slice(0, 79)}…` : best;
      if (next !== panel.title) {
        panel.title = next;
        changed = true;
      }
    }
    if (changed) deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
  }

  /** In-band auto-title trigger. Returns a proposed title, or null when
   * the event isn't a re-title signal.
   *
   *   - Any panel + `meta` with `record_type === 'session-title'`: an
   *     explicit agent-emitted retitle. `raw.title` is the proposal.
   *
   * Returned strings are pre-truncated to the 80-char display cap; the
   * caller routes the proposal through `applyAutoTitle` so the title
   * change comes with the flash/toast cue. */
  private maybeProposeAutoTitle(_panel: Panel, event: Event, _titleBefore: string): string | null {
    if (event.kind === 'meta' && event.payload.record_type === 'session-title') {
      const raw = (event.payload.raw ?? {}) as { title?: string };
      const proposed = (raw.title ?? '').trim();
      if (!proposed) return null;
      return proposed.length > 80 ? `${proposed.slice(0, 79)}…` : proposed;
    }
    // Inline auto-title marker: the auto-title-inline UserPromptSubmit hook
    // asks the model to emit `<!-- bh-title: X -->` at the end of its
    // response. HTML-comment form so it stays invisible in any markdown
    // renderer (Claude Code's own UI included). KEEP is a no-op; anything
    // else is a proposal. The client transform stripBhTitleMarker still
    // scrubs it defensively before render.
    if (event.kind === 'assistant_text') {
      const text = (event.payload as { text?: string }).text ?? '';
      const m = text.match(/<!--\s*bh-title:\s*([\s\S]*?)\s*-->/);
      if (!m) return null;
      const candidate = (m[1] ?? '').trim();
      if (!candidate || /^keep$/i.test(candidate)) return null;
      const cleaned = candidate.replace(/^["'`]+|["'`]+$/g, '').trim();
      if (!cleaned) return null;
      return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
    }
    return null;
  }

  private toDto(p: Panel): PanelDto {
    return {
      id: p.id,
      kind: p.kind,
      parent_panel_id: p.parent_panel_id,
      title: p.title,
      agent_type: p.agent_type,
      task_description: p.task_description,
      account_label: p.account_label,
      binned_at: p.binned_at,
      status: p.status,
      started_at: p.started_at,
      last_event_at: p.last_event_at,
      status_changed_at: p.status_changed_at,
      event_count: p.events.length,
      cwd: p.cwd,
      repo_root: p.repo_root,
      theme: p.theme,
      awaiting_input: p.awaiting_input,
      ended: p.ended,
      ended_provenance: p.ended_provenance,
      manually_renamed: p.manually_renamed,
      tokens: p.tokens,
      context_size: p.context_size,
      hook_overhead_tokens: p.hook_overhead_tokens,
    };
  }

  /** Materialize a session_summary row without touching `ended` or any
   * other panel state. Used for parent Stop hooks where the session
   * ended a *turn* (worth summarizing) but may take another prompt. */
  recordSessionEnd(panelId: string, provenance: SessionSummaryRow['ended_provenance']): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    this.materializeSummary(panel, provenance);
  }

  /** Accumulate token-cost accounting for a brainhouse hook that injected
   * context (UserPromptSubmit `additionalContext`, SessionStart
   * `additionalContext` / `initialUserMessage`). The hook itself
   * estimates tokens (chars/4 proxy) and reports them via a
   * `hook_overhead` side-channel record; we sum them onto the panel and
   * surface the running total in the DTO so the UI can show
   * "instrumentation overhead". */
  /** Arm inherited-title suppression for a session about to start via
   * `/clear`. If the panel already exists we set the marker directly;
   * otherwise we stash the id and `ensurePanel` picks it up. The new
   * session's first `custom-title` meta — which Claude Code carries
   * over from the prior transcript — will be dropped.
   *
   * Late-arming case: when the watcher creates the new panel from JSONL
   * before the SessionStart hook fires, the inherited custom-title meta
   * has already been processed and `panel.title` reflects it. Detect
   * that — title differs from the short-id placeholder — and reset it
   * to `initialTitle` so the suppression actually takes effect. Returns
   * a `panel_upsert` delta in that case so clients see the rename. */
  armClearTitleSuppression(panelId: string): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel) {
      this.pendingClearTitleSuppression.add(panelId);
      return [];
    }
    const deltas: Delta[] = [];
    // Unwind a custom title that landed before the hook armed
    // suppression. We can tell because `panel.title` is no longer the
    // short-id placeholder — the only thing that would have changed it
    // this early is a `custom-title` meta carried over from the prior
    // session. Reset to the placeholder and seed `suppressed_title`
    // with the unwound text so subsequent identical re-emissions are
    // also dropped.
    const placeholder = initialTitle(panel.id, panel.kind);
    if (panel.title !== placeholder) {
      panel.clear_title_suppression = { suppressed_title: panel.title };
      panel.title = placeholder;
      deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    } else {
      panel.clear_title_suppression = { suppressed_title: null };
    }
    this.persistPanel(panel);
    return deltas;
  }

  recordHookOverhead(panelId: string, tokens: number): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel) return [];
    if (!Number.isFinite(tokens) || tokens <= 0) return [];
    panel.hook_overhead_tokens += Math.floor(tokens);
    this.persistPanel(panel);
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  /** Apply an auto-title proposal from the Stop-hook side-channel. Dedupes
   * against the current title; no-op when the proposal matches. On accept,
   * mutates panel.title, emits panel_upsert (so reloads get the fresh
   * title), an event_append with a synthetic meta event for inline
   * visibility, and an `auto_titled` delta the UI uses to drive the
   * title-flash + toast. */
  applyAutoTitle(panelId: string, proposed: string): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel) return [];
    const next = proposed.trim();
    if (!next || next === panel.title) return [];
    const prev = panel.title;
    panel.title = next;
    this.persistPanel(panel);
    const syntheticEvent: Event = {
      uuid: `${panelId}:auto-title:${Math.round(this.clock())}`,
      session_id: panelId,
      agent_id: null,
      parent_uuid: null,
      kind: 'meta',
      tags: ['meta'],
      ts: new Date(this.clock() * 1000).toISOString(),
      cwd: panel.cwd,
      payload: {
        record_type: 'auto-title',
        raw: { previous: prev, current: next },
      },
    };
    panel.events.push(syntheticEvent);
    return [
      { op: 'panel_upsert', panel: this.toDto(panel) },
      { op: 'event_append', panel_id: panelId, event: syntheticEvent },
      { op: 'auto_titled', panel_id: panelId, prev_title: prev, new_title: next },
    ];
  }

  /** Mark a panel as explicitly ended. Idempotent; only emits a delta when
   * the flag flips. Lifecycle status is left alone — `ended` is orthogonal
   * to live/done/mini so an ended panel still progresses to the dock. */
  /** Post-bootstrap sweep: subagent panels whose final event is older than
   * `maxIdleSeconds` get marked ended with `bootstrap_stale`. Replayed
   * old transcripts have no SubagentStop hook event to drive a real end,
   * so without this they sit in the dock as "live-but-idle" until the
   * lifecycle removeAfter timer reaps them. Returns broadcast-ready
   * deltas; caller owns the emit. */
  endStaleSubagents(maxIdleSeconds: number): Delta[] {
    const now = this.clock();
    const deltas: Delta[] = [];
    for (const panel of this.panels.values()) {
      if (panel.kind !== 'subagent') continue;
      if (panel.ended) continue;
      if (now - panel.last_event_at <= maxIdleSeconds) continue;
      panel.ended = true;
      panel.ended_provenance = 'bootstrap_stale';
      this.persistPanel(panel);
      this.materializeSummary(panel, 'bootstrap_stale');
      deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    }
    return deltas;
  }

  markEnded(panelId: string, provenance: PanelEndedProvenance = 'hook_subagent_stop'): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel || panel.ended) return [];
    panel.ended = true;
    panel.ended_provenance = provenance;
    this.persistPanel(panel);
    this.materializeSummary(panel, provenance);
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  // ---- persistence write-through ----
  //
  // Every mutation that changes panel state calls persistPanel(); ingests
  // call persistEvent(); end-of-session transitions call materializeSummary().
  // All cheap when `store` is null (no-ops); when set, write-through is
  // synchronous (matches SessionStore's sync model — node:sqlite is fast
  // enough that the overhead is negligible at our event rates).

  private persistPanel(panel: Panel): void {
    if (!this.store) return;
    this.store.upsertPanel(panelToRow(panel, this.clock()));
  }

  private persistEvent(panel: Panel, event: Event, ts: number): void {
    if (!this.store) return;
    this.store.recordEvent(eventToIndexRow(panel.id, event, ts));
    this.store.incrementEventStat(event.kind, deriveStatSubkey(event), ts);
  }

  private materializeSummary(
    panel: Panel,
    provenance: PanelEndedProvenance | 'idle_timeout' | 'never',
  ): void {
    if (!this.store) return;
    this.store.materializeSession(buildSessionSummary(panel, provenance, this.clock()));
  }
}

type PanelEndedProvenance = NonNullable<Panel['ended_provenance']>;

/** Returns true when the event carries a `brainhouse-checklist` fenced block
 * whose items are *all* done. Mirrors the client-side parser in
 * `client/src/transforms/builtIn/scanChecklist.ts` so the server's
 * progress_complete detection lines up exactly with the UI's completion
 * sweep. Only considers the *last* checklist block in the text (matches
 * the "most recent wins" rule the client uses). */
export function isChecklistComplete(event: Event): boolean {
  if (event.kind !== 'user_text' && event.kind !== 'assistant_text') return false;
  const text = (event.payload as { text?: unknown }).text;
  if (typeof text !== 'string') return false;
  const items = extractLastChecklistItems(text);
  if (!items || items.length === 0) return false;
  return items.every((i) => i.done);
}

function extractLastChecklistItems(text: string): Array<{ done: boolean; text: string }> | null {
  const re = /```brainhouse-checklist\s*\n([\s\S]*?)```/g;
  let last: Array<{ done: boolean; text: string }> | null = null;
  let m: RegExpExecArray | null;
  while (true) {
    m = re.exec(text);
    if (!m) break;
    const items: Array<{ done: boolean; text: string }> = [];
    const body = m[1] ?? '';
    for (const line of body.split('\n')) {
      const im = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
      if (im?.[1] !== undefined && im[2] !== undefined) {
        items.push({ done: /[xX]/.test(im[1]), text: im[2] });
      }
    }
    if (items.length) last = items;
  }
  return last;
}

/** Reproduce Claude Code's mapping from `cwd` → project-dir basename.
 * Both `/` and `.` are replaced with `-` (so `/Users/me/.config/x` and
 * `/Users/me/-config/x` collide — that's fine, it matches Claude's own
 * encoding and we only use this for equality comparison). */
export function encodeCwdToProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

function parseEventTs(ts: string): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function panelIdentity(event: Event): {
  id: string;
  kind: PanelKind;
  parent_panel_id: string | null;
} {
  if (event.agent_id) {
    return { id: event.agent_id, kind: 'subagent', parent_panel_id: event.session_id };
  }
  return { id: event.session_id, kind: 'parent', parent_panel_id: null };
}

function initialTitle(panelId: string, kind: PanelKind): string {
  if (kind === 'subagent') {
    let short = panelId;
    for (const prefix of ['agent-', 'subagent-']) {
      if (short.startsWith(prefix)) {
        short = short.slice(prefix.length);
        break;
      }
    }
    return `subagent · ${short.slice(0, 10)}`;
  }
  return panelId.slice(0, 8);
}

/** The tool_use_id of the parent `Task` call that spawned a subagent, read
 * from the `source_tool_use_id` on the subagent's first user message. Null
 * until that message has been seen (or if it's since been evicted). */
function subagentSpawnToolUseId(panel: Panel): string | null {
  for (const e of panel.events) {
    if (e.kind === 'user_text' && e.payload.source_tool_use_id) {
      return e.payload.source_tool_use_id;
    }
  }
  return null;
}

// ---- Panel ↔ Store row conversions ----

function panelToRow(p: Panel, now: number): PanelRow {
  return {
    id: p.id,
    kind: p.kind,
    parent_panel_id: p.parent_panel_id,
    title: p.title,
    agent_type: p.agent_type,
    account_label: p.account_label,
    status: p.status,
    started_at: p.started_at,
    last_event_at: p.last_event_at,
    status_changed_at: p.status_changed_at,
    cwd: p.cwd,
    repo_root: p.repo_root,
    theme_bg: p.theme?.background ?? null,
    theme_fg: p.theme?.foreground ?? null,
    binned_at: p.binned_at,
    awaiting_input: p.awaiting_input,
    ended: p.ended,
    ended_provenance: p.ended_provenance,
    manually_renamed: p.manually_renamed,
    updated_at: now,
  };
}

function panelRowToPanel(r: PanelRow): Panel {
  return {
    id: r.id,
    kind: r.kind,
    parent_panel_id: r.parent_panel_id,
    title: r.title,
    agent_type: r.agent_type,
    task_description: null,
    account_label: r.account_label,
    status: r.status,
    started_at: r.started_at,
    last_event_at: r.last_event_at,
    status_changed_at: r.status_changed_at,
    cwd: r.cwd,
    // Repo root was persisted on the previous run; if missing (old row
    // pre-migration), fall back to a live filesystem walk.
    repo_root: r.repo_root ?? findRepoRoot(r.cwd),
    theme: r.theme_bg && r.theme_fg ? { background: r.theme_bg, foreground: r.theme_fg } : null,
    events: [], // hydrated lazily — JSONL on disk is canonical
    binned_at: r.binned_at,
    awaiting_input: r.awaiting_input,
    ended: r.ended,
    ended_provenance: r.ended_provenance,
    manually_renamed: r.manually_renamed,
    // Tokens aren't persisted to the panels table yet (would require a
    // schema migration). On hydrate we start at zero and re-accumulate
    // as the watcher replays the JSONL. Brief flicker on restart;
    // acceptable trade-off vs. the schema work for now.
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    context_size: 0,
    hook_overhead_tokens: 0,
    // Not persisted: a /clear's suppression window is short-lived and
    // closes on the user's first post-clear prompt. If brainhouse
    // restarts mid-window we accept the inherited title.
    clear_title_suppression: null,
  };
}

/** Map an Event into a small row for events_index. Only summary fields —
 * the full payload stays in the JSONL on disk. */
/** Second-axis breakdown for `event_stats`. Returns the empty string when
 * no useful subkey applies (the kind alone is the whole story). */
export function deriveStatSubkey(event: Event): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case 'tool_use':
      return typeof p.name === 'string' ? p.name : '(unknown)';
    case 'tool_result':
      return p.is_error === true ? 'error' : 'ok';
    case 'resource_usage':
      return typeof p.model === 'string' ? p.model : '(no model)';
    case 'system':
      return typeof p.subtype === 'string' && p.subtype ? p.subtype : '(no subtype)';
    case 'meta':
      return typeof p.record_type === 'string' && p.record_type
        ? p.record_type
        : '(no record_type)';
    default:
      return '';
  }
}

function eventToIndexRow(panelId: string, event: Event, fallbackTs: number): EventIndexRow {
  const ts = parseEventTs(event.ts) ?? fallbackTs;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  let toolName: string | null = null;
  let filePath: string | null = null;
  let summary: string | null = null;
  if (event.kind === 'tool_use' && typeof p.name === 'string') {
    toolName = p.name;
    const input = (p.input ?? {}) as Record<string, unknown>;
    if (typeof input.file_path === 'string') filePath = input.file_path;
    else if (typeof input.path === 'string') filePath = input.path;
    // Stash extra metadata for cross-session aggregations (flows graph).
    // Task → subagent_type drives the `subagent:<type>` node taxonomy.
    // tool_use_id lets downstream readers tie a later tool_result back
    // to its tool name (which tool_result events otherwise don't carry).
    const meta: Record<string, string> = {};
    if (typeof p.tool_use_id === 'string') meta.tool_use_id = p.tool_use_id;
    if (toolName === 'Task' && typeof input.subagent_type === 'string') {
      meta.subagent_type = input.subagent_type;
    }
    if (Object.keys(meta).length > 0) summary = JSON.stringify(meta);
  } else if (event.kind === 'tool_result' && typeof p.tool_use_id === 'string') {
    summary = JSON.stringify({ tool_use_id: p.tool_use_id });
  }
  return {
    panel_id: panelId,
    event_uuid: event.uuid,
    ts,
    kind: event.kind,
    tool_name: toolName,
    file_path: filePath,
    summary,
  };
}

/** Aggregate a panel's in-memory events into a session_summary row. */
export function buildSessionSummary(
  p: Panel,
  provenance: SessionSummaryRow['ended_provenance'],
  now: number,
): SessionSummaryRow {
  let toolCallCount = 0;
  let errorCount = 0;
  const toolMix: Record<string, number> = {};
  const fileEdits: Record<string, number> = {};
  let lastAsst = '';
  for (const e of p.events) {
    if (e.kind === 'tool_use') {
      toolCallCount++;
      const name = (e.payload as { name?: string }).name ?? 'tool';
      toolMix[name] = (toolMix[name] ?? 0) + 1;
      const input = (e.payload as { input?: Record<string, unknown> }).input ?? {};
      const fp = typeof input.file_path === 'string' ? input.file_path : null;
      if (fp && (name === 'Edit' || name === 'Write' || name === 'MultiEdit')) {
        fileEdits[fp] = (fileEdits[fp] ?? 0) + 1;
      }
    } else if (e.kind === 'tool_result' && (e.payload as { is_error?: boolean }).is_error) {
      errorCount++;
    } else if (e.kind === 'assistant_text') {
      lastAsst = (e.payload as { text?: string }).text ?? lastAsst;
    }
  }
  const topFiles = Object.entries(fileEdits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([f]) => f);
  return {
    session_id: p.id,
    kind: p.kind,
    parent_session_id: p.parent_panel_id,
    account_label: p.account_label,
    title: p.title,
    agent_type: p.agent_type,
    cwd: p.cwd,
    started_at: p.started_at,
    ended_at: p.last_event_at,
    duration_active_s: Math.max(0, p.last_event_at - p.started_at),
    ended_provenance: provenance,
    event_count: p.events.length,
    tool_call_count: toolCallCount,
    error_count: errorCount,
    unique_files_touched: Object.keys(fileEdits).length,
    tool_mix_json: JSON.stringify(toolMix),
    key_files_json: JSON.stringify(topFiles),
    key_decisions: lastAsst ? lastAsst.slice(0, 500) : null,
    open_threads_json: null, // populated by later passes
    pinned_checklist_json: null, // populated by later passes
    rolled_up_at: now,
  };
}

/** Add a resource_usage payload's counters onto the panel's running totals.
 * Last-seen model wins for the panel-level `model` field. */
function accumulateUsage(
  panel: Panel,
  usage: {
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  },
): boolean {
  panel.tokens.input += usage.input_tokens;
  panel.tokens.output += usage.output_tokens;
  panel.tokens.cache_create += usage.cache_creation_input_tokens;
  panel.tokens.cache_read += usage.cache_read_input_tokens;
  if (usage.model) panel.tokens.model = usage.model;
  // context_size is *overwritten*, not accumulated: it's the size of the
  // active context window for the most recent turn (input + both cache
  // buckets, since cache_read is the prompt-cached portion of input that
  // still counts toward what's in context).
  panel.context_size =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  return (
    usage.input_tokens > 0 ||
    usage.output_tokens > 0 ||
    usage.cache_creation_input_tokens > 0 ||
    usage.cache_read_input_tokens > 0 ||
    usage.model !== null
  );
}
