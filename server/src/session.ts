/**
 * Panel state and lifecycle.
 *
 * Mirrors pensieve/session.py. A Panel is one parent session or one subagent
 * inside it. Lifecycle is time-driven:
 *   live → done   after `idleSeconds` with no new events
 *   done → mini   after `miniSeconds` in the done state
 *   mini → removed (deleted) after `removeAfterSeconds` in mini
 *
 * Time comes from an injectable clock so tests are deterministic.
 */

import type { Event } from './parser.js';

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
}

export class SessionStore {
  idleSeconds: number;
  miniSeconds: number;
  removeAfterSeconds: number;
  private readonly clock: () => number;
  private readonly panels = new Map<string, Panel>();

  constructor(opts: SessionStoreOptions = {}) {
    this.idleSeconds = opts.idleSeconds ?? 60;
    this.miniSeconds = opts.miniSeconds ?? 5 * 60;
    this.removeAfterSeconds = opts.removeAfterSeconds ?? 24 * 60 * 60;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
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
    const panel = this.ensurePanel(event, now, deltas, opts.accountLabel ?? null);
    // Dedupe by uuid. The watcher re-reads `.meta.json` sidecars on every
    // change event and emits with a stable `agent-X:meta` uuid; without this
    // guard those duplicates pile up in `panel.events` and React's list
    // renderer complains about non-unique keys.
    if (panel.events.some((e) => e.uuid === event.uuid)) return deltas;
    panel.events.push(event);
    // Cap event history per panel — oldest entries lose first.
    if (panel.events.length > MAX_EVENTS_PER_PANEL) {
      panel.events.splice(0, Math.ceil(MAX_EVENTS_PER_PANEL * EVICT_FRACTION));
    }
    // Use the event's own timestamp so bootstrap-replayed events don't all
    // collapse to "just now" — but never project into the future.
    const eventTs = parseEventTs(event.ts);
    const ts = eventTs !== null ? Math.min(eventTs, now) : now;
    panel.last_event_at = Math.max(panel.last_event_at, ts);
    // Any fresh activity clears the awaiting-input flag.
    if (panel.awaiting_input) {
      panel.awaiting_input = false;
      deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    }
    if (panel.status !== 'live') {
      panel.status = 'live';
      panel.status_changed_at = panel.last_event_at;
      deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'live' });
    }
    this.maybeUpdateTitle(panel, event, deltas);
    this.maybeAdoptCwd(panel, event, deltas);
    deltas.push({ op: 'event_append', panel_id: panel.id, event });
    return deltas;
  }

  /** Stamp the panel's theme. Called by the monitor once .hued has been read. */
  setTheme(panelId: string, theme: PanelTheme | null): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel) return [];
    panel.theme = theme;
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  tick(now?: number): Delta[] {
    const t = now ?? this.clock();
    const deltas: Delta[] = [];
    const toRemove: string[] = [];
    for (const panel of this.panels.values()) {
      // Binned panels are frozen — no auto live→done→mini→removed progression.
      if (panel.binned_at !== null) continue;
      if (panel.status === 'live' && t - panel.last_event_at >= this.idleSeconds) {
        panel.status = 'done';
        // Stamp when the panel *actually* went idle so a bootstrap-replayed
        // session shows "done 2h ago" instead of "done 0s ago".
        panel.status_changed_at = Math.min(t, panel.last_event_at + this.idleSeconds);
        deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'done' });
      } else if (panel.status === 'done' && t - panel.status_changed_at >= this.miniSeconds) {
        panel.status = 'mini';
        panel.status_changed_at = Math.min(t, panel.status_changed_at + this.miniSeconds);
        deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'mini' });
      } else if (
        panel.status === 'mini' &&
        t - panel.status_changed_at >= this.removeAfterSeconds
      ) {
        toRemove.push(panel.id);
      }
    }
    for (const id of toRemove) {
      this.panels.delete(id);
      deltas.push({ op: 'panel_remove', panel_id: id });
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
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  /** Permanent removal. Used by the trash-bin "purge" button or the
   * lifecycle auto-removal for unbinned panels. */
  remove(panelId: string): Delta[] {
    if (!this.panels.has(panelId)) return [];
    this.panels.delete(panelId);
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
    return [{ op: 'panel_status', panel_id: panelId, status }];
  }

  /** Toggle the "this panel is blocking on user input" flag. Emits an upsert
   * delta when the value actually changes. Cleared automatically on next
   * ingested event. */
  setAwaiting(panelId: string, awaiting: boolean): Delta[] {
    const panel = this.panels.get(panelId);
    if (!panel || panel.awaiting_input === awaiting) return [];
    panel.awaiting_input = awaiting;
    return [{ op: 'panel_upsert', panel: this.toDto(panel) }];
  }

  /** Find live panels that originated from a given transcript file. Used by
   * the hook bridge to route SubagentStop to a specific subagent rather
   * than the whole session. Best-effort: matches against the most recent
   * event in each panel. */
  findPanelByTranscriptPath(transcriptPath: string): Panel | undefined {
    for (const panel of this.panels.values()) {
      const last = panel.events[panel.events.length - 1];
      if (last && (last as { source_path?: string }).source_path === transcriptPath) return panel;
    }
    return undefined;
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
      status: 'live',
      started_at: now,
      last_event_at: now,
      status_changed_at: now,
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
    };
  }
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
