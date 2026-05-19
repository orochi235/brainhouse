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

export interface Panel {
  id: string;
  kind: PanelKind;
  parent_panel_id: string | null;
  title: string;
  status: PanelStatus;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  events: Event[];
}

export interface PanelDto {
  id: string;
  kind: PanelKind;
  parent_panel_id: string | null;
  title: string;
  status: PanelStatus;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  event_count: number;
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
  readonly idleSeconds: number;
  readonly miniSeconds: number;
  readonly removeAfterSeconds: number;
  private readonly clock: () => number;
  private readonly panels = new Map<string, Panel>();

  constructor(opts: SessionStoreOptions = {}) {
    this.idleSeconds = opts.idleSeconds ?? 60;
    this.miniSeconds = opts.miniSeconds ?? 5 * 60;
    this.removeAfterSeconds = opts.removeAfterSeconds ?? 24 * 60 * 60;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
  }

  apply(event: Event): Delta[] {
    const now = this.clock();
    const deltas: Delta[] = [];
    const panel = this.ensurePanel(event, now, deltas);
    panel.events.push(event);
    panel.last_event_at = now;
    if (panel.status !== 'live') {
      panel.status = 'live';
      panel.status_changed_at = now;
      deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'live' });
    }
    this.maybeUpdateTitle(panel, event, deltas);
    deltas.push({ op: 'event_append', panel_id: panel.id, event });
    return deltas;
  }

  tick(now?: number): Delta[] {
    const t = now ?? this.clock();
    const deltas: Delta[] = [];
    const toRemove: string[] = [];
    for (const panel of this.panels.values()) {
      if (panel.status === 'live' && t - panel.last_event_at >= this.idleSeconds) {
        panel.status = 'done';
        panel.status_changed_at = t;
        deltas.push({ op: 'panel_status', panel_id: panel.id, status: 'done' });
      } else if (panel.status === 'done' && t - panel.status_changed_at >= this.miniSeconds) {
        panel.status = 'mini';
        panel.status_changed_at = t;
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

  remove(panelId: string): Delta[] {
    if (!this.panels.has(panelId)) return [];
    this.panels.delete(panelId);
    return [{ op: 'panel_remove', panel_id: panelId }];
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

  snapshot(): Array<PanelDto & { events: Event[] }> {
    return Array.from(this.panels.values()).map((p) => ({
      ...this.toDto(p),
      events: p.events.slice(),
    }));
  }

  panel(panelId: string): Panel | undefined {
    return this.panels.get(panelId);
  }

  private ensurePanel(event: Event, now: number, deltas: Delta[]): Panel {
    const { id, kind, parent_panel_id } = panelIdentity(event);
    const existing = this.panels.get(id);
    if (existing) return existing;
    const panel: Panel = {
      id,
      kind,
      parent_panel_id,
      title: initialTitle(id, kind),
      status: 'live',
      started_at: now,
      last_event_at: now,
      status_changed_at: now,
      events: [],
    };
    this.panels.set(id, panel);
    deltas.push({ op: 'panel_upsert', panel: this.toDto(panel) });
    return panel;
  }

  private maybeUpdateTitle(panel: Panel, event: Event, deltas: Delta[]): void {
    if (panel.kind !== 'subagent') return;
    if (event.kind !== 'meta') return;
    if (event.payload.record_type !== 'subagent-meta') return;
    const raw = (event.payload.raw ?? {}) as { agentType?: string; description?: string };
    const agentType = raw.agentType ?? '';
    const description = (raw.description ?? '').trim();
    let title = panel.title;
    if (agentType && description) title = `${agentType}: ${description.slice(0, 60)}`;
    else if (description) title = description.slice(0, 80);
    else if (agentType) title = agentType;
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
      status: p.status,
      started_at: p.started_at,
      last_event_at: p.last_event_at,
      status_changed_at: p.status_changed_at,
      event_count: p.events.length,
    };
  }
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
