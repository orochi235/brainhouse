/**
 * TranscriptMonitor wires the watcher and session store together and exposes
 * a delta stream for subscribers.
 *
 * Mirrors pensieve/app.py:Application — bridges Event arrival → SessionStore
 * mutations → Delta broadcast, plus drives the periodic tick that advances
 * live → done → mini → removed transitions.
 */

import { EventEmitter } from 'node:events';
import type { Event } from './parser.js';
import { type Delta, SessionStore } from './session.js';
import { readPanelTheme } from './theme.js';
import { TranscriptWatcher } from './watcher.js';

export interface MonitorOptions {
  roots: string[];
  idleSeconds?: number;
  miniSeconds?: number;
  removeAfterSeconds?: number;
  tickIntervalMs?: number;
}

export class TranscriptMonitor {
  readonly store: SessionStore;
  readonly watcher: TranscriptWatcher;
  readonly emitter = new EventEmitter();
  private readonly tickIntervalMs: number;
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(opts: MonitorOptions) {
    this.store = new SessionStore({
      idleSeconds: opts.idleSeconds,
      miniSeconds: opts.miniSeconds,
      removeAfterSeconds: opts.removeAfterSeconds,
    });
    this.watcher = new TranscriptWatcher(opts.roots, (event) => this.ingest(event));
    this.tickIntervalMs = opts.tickIntervalMs ?? 5000;
    // Default emitter caps listener count at 10; the WS subscribers will easily
    // exceed that during dev with HMR opening fresh connections.
    this.emitter.setMaxListeners(100);
  }

  async start({ watch = true }: { watch?: boolean } = {}): Promise<void> {
    await this.watcher.start({ watch });
    this.tickHandle = setInterval(() => {
      for (const delta of this.store.tick()) this.broadcast(delta);
    }, this.tickIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
    await this.watcher.stop();
  }

  /** Push a synthesized event (used by both the watcher and debug spawns). */
  ingest(event: Event): void {
    for (const delta of this.store.apply(event)) this.broadcast(delta);
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
