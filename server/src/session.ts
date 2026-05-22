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

import type { Event } from './parser.js';
import type { EventIndexRow, PanelRow, SessionSummaryRow, Store } from './store.js';

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
  /** Optional account label (from prefs.roots[].label) identifying which
   * Claude config root owns this session. Client renders a small badge when
   * more than one account is configured. */
  account_label: string | null;
  status: PanelStatus;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  cwd: string | null;
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
}

export interface PanelDto {
  id: string;
  kind: PanelKind;
  parent_panel_id: string | null;
  title: string;
  agent_type: string | null;
  account_label: string | null;
  status: PanelStatus;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  event_count: number;
  cwd: string | null;
  theme: PanelTheme | null;
  binned_at: number | null;
  awaiting_input: boolean;
  ended: boolean;
  ended_provenance: Panel['ended_provenance'];
  tokens: {
    input: number;
    output: number;
    cache_create: number;
    cache_read: number;
    model: string | null;
  };
  context_size: number;
}

export type Delta =
  | { op: 'panel_upsert'; panel: PanelDto }
  | { op: 'panel_status'; panel_id: string; status: PanelStatus }
  | { op: 'panel_remove'; panel_id: string }
  | { op: 'event_append'; panel_id: string; event: Event };

export interface SessionStoreOptions {
  idleSeconds?: number;
  miniSeconds?: number;
  removeAfterSeconds?: number;
  clock?: () => number;
  /** Optional persistence layer. When set, panel state mirrors into the
   * `panels` table on every transition, events go into `events_index`,
   * and `session_summary` rows are materialized on end-of-session. */
  store?: Store | null;
}

export class SessionStore {
  idleSeconds: number;
  miniSeconds: number;
  removeAfterSeconds: number;
  private readonly clock: () => number;
  private readonly panels = new Map<string, Panel>();
  private readonly store: Store | null;

  constructor(opts: SessionStoreOptions = {}) {
    this.idleSeconds = opts.idleSeconds ?? 60;
    this.miniSeconds = opts.miniSeconds ?? 5 * 60;
    this.removeAfterSeconds = opts.removeAfterSeconds ?? 24 * 60 * 60;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.store = opts.store ?? null;
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
    panel.last_event_at = Math.max(panel.last_event_at, ts);
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
    if (!panel.ended && panel.status !== 'live') {
      panel.status = 'live';
      panel.status_changed_at = panel.last_event_at;
      deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'live' });
    }
    this.maybeUpdateTitle(panel, event, deltas);
    this.maybeAdoptCwd(panel, event, deltas);
    deltas.push({ op: 'event_append', panel_id: panel.id, event });
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
      if (panel.status === 'live' && t - panel.last_event_at >= this.idleSeconds) {
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
        t - panel.status_changed_at >= this.removeAfterSeconds
      ) {
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
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
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

  /** Subagent panels (live or done) parented to a given session. Used by
   * SubagentStop to find which subagent to demote — Claude Code's hook
   * payload doesn't directly identify the subagent id, so we collapse all
   * live ones under the parent. */
  liveSubagentsOf(parentSessionId: string): Panel[] {
    return Array.from(this.panels.values()).filter(
      (p) => p.kind === 'subagent' && p.parent_panel_id === parentSessionId && p.status === 'live',
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
   *
   * Returns the single best candidate (most recent last_event_at) or null. */
  findSupersedablePanel(opts: {
    encodedCwdDir: string;
    excludeId: string;
    now: number;
    withinSeconds: number;
  }): Panel | null {
    const floor = opts.now - opts.withinSeconds;
    let best: Panel | null = null;
    for (const p of this.panels.values()) {
      if (p.kind !== 'parent') continue;
      if (p.ended) continue;
      if (p.binned_at !== null) continue;
      if (p.id === opts.excludeId) continue;
      if (!p.cwd) continue;
      if (encodeCwdToProjectDir(p.cwd) !== opts.encodedCwdDir) continue;
      if (p.last_event_at < floor) continue;
      if (!best || p.last_event_at > best.last_event_at) best = p;
    }
    return best;
  }

  snapshot(): Array<PanelDto & { events: Event[] }> {
    return Array.from(this.panels.values())
      .filter((p) => p.binned_at === null)
      .map((p) => ({
        ...this.toDto(p),
        events: p.events.slice(),
      }));
  }

  panel(panelId: string): Panel | undefined {
    return this.panels.get(panelId);
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
    const panel: Panel = {
      id,
      kind,
      parent_panel_id,
      title: initialTitle(id, kind),
      agent_type: null,
      account_label: accountLabel,
      binned_at: null,
      awaiting_input: false,
      ended: false,
      ended_provenance: null,
      tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
      context_size: 0,
      status: 'live',
      // started_at is wall-clock-now so the panel "age" reflects the
      // observation; last_event_at/status_changed_at are stamped with the
      // event's own ts so bootstrap-replay shows the right "X ago".
      started_at: now,
      last_event_at: eventTs,
      status_changed_at: eventTs,
      cwd: event.cwd,
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
    deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
  }

  private maybeUpdateTitle(panel: Panel, event: Event, deltas: Delta[]): void {
    let title = panel.title;
    // Explicit /rename — always wins, regardless of panel kind or current title.
    if (event.kind === 'meta' && event.payload.record_type === 'custom-title') {
      const raw = (event.payload.raw ?? {}) as { customTitle?: string };
      const custom = (raw.customTitle ?? '').trim();
      if (custom) title = custom.length > 80 ? `${custom.slice(0, 79)}…` : custom;
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
      if (/^<(local-command-(caveat|stdout)|command-(name|message|args))>/.test(text)) return;
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

  private toDto(p: Panel): PanelDto {
    return {
      id: p.id,
      kind: p.kind,
      parent_panel_id: p.parent_panel_id,
      title: p.title,
      agent_type: p.agent_type,
      account_label: p.account_label,
      binned_at: p.binned_at,
      status: p.status,
      started_at: p.started_at,
      last_event_at: p.last_event_at,
      status_changed_at: p.status_changed_at,
      event_count: p.events.length,
      cwd: p.cwd,
      theme: p.theme,
      awaiting_input: p.awaiting_input,
      ended: p.ended,
      ended_provenance: p.ended_provenance,
      tokens: p.tokens,
      context_size: p.context_size,
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

  /** Mark a panel as explicitly ended. Idempotent; only emits a delta when
   * the flag flips. Lifecycle status is left alone — `ended` is orthogonal
   * to live/done/mini so an ended panel still progresses to the dock. */
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
    theme_bg: p.theme?.background ?? null,
    theme_fg: p.theme?.foreground ?? null,
    binned_at: p.binned_at,
    awaiting_input: p.awaiting_input,
    ended: p.ended,
    ended_provenance: p.ended_provenance,
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
    account_label: r.account_label,
    status: r.status,
    started_at: r.started_at,
    last_event_at: r.last_event_at,
    status_changed_at: r.status_changed_at,
    cwd: r.cwd,
    theme: r.theme_bg && r.theme_fg ? { background: r.theme_bg, foreground: r.theme_fg } : null,
    events: [], // hydrated lazily — JSONL on disk is canonical
    binned_at: r.binned_at,
    awaiting_input: r.awaiting_input,
    ended: r.ended,
    ended_provenance: r.ended_provenance,
    // Tokens aren't persisted to the panels table yet (would require a
    // schema migration). On hydrate we start at zero and re-accumulate
    // as the watcher replays the JSONL. Brief flicker on restart;
    // acceptable trade-off vs. the schema work for now.
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    context_size: 0,
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
function buildSessionSummary(
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
