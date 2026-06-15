/**
 * Per-panel pipeline-trace store. The runner writes a fresh
 * `PanelTrace` here every time it runs with tracing on (gated by the
 * `tracing` flag this module also owns). The inspector subscribes via
 * `usePanelTrace`. Entries don't persist across reloads; when a panel
 * unmounts it can call `clear(panelId)` to drop its entry.
 */

import { type ReactNode, createContext, useContext, useSyncExternalStore } from 'react';
import type { TraceRecord } from './selectors/types.ts';
import type { Stage2TraceRecord } from './runner.ts';

export interface PanelTrace {
  perEvent: TraceRecord[];
  stage2: Stage2TraceRecord[];
  generatedAt: number;
}

interface PanelEntry {
  trace: PanelTrace | undefined;
  tracing: boolean;
  listeners: Set<() => void>;
}

class TraceStoreImpl {
  private panels = new Map<string, PanelEntry>();

  private entry(panelId: string): PanelEntry {
    let e = this.panels.get(panelId);
    if (!e) {
      e = { trace: undefined, tracing: false, listeners: new Set() };
      this.panels.set(panelId, e);
    }
    return e;
  }

  private notify(panelId: string): void {
    const e = this.panels.get(panelId);
    if (!e) return;
    for (const fn of e.listeners) fn();
  }

  get(panelId: string): PanelTrace | undefined {
    return this.panels.get(panelId)?.trace;
  }

  write(panelId: string, trace: PanelTrace): void {
    const e = this.entry(panelId);
    e.trace = trace;
    this.notify(panelId);
  }

  clear(panelId: string): void {
    const e = this.panels.get(panelId);
    if (!e) return;
    e.trace = undefined;
    this.notify(panelId);
  }

  /** Release a panel's entry once it's gone for good. If something is
   * still subscribed (shouldn't happen for a removed panel, but guard
   * anyway) we only drop the heavy trace payload and keep the entry
   * wired; otherwise the whole entry is deleted. */
  forget(panelId: string): void {
    const e = this.panels.get(panelId);
    if (!e) return;
    if (e.listeners.size > 0) {
      e.trace = undefined;
      return;
    }
    this.panels.delete(panelId);
  }

  /** Forget every panel the server no longer knows about. Mirrors the
   * prune-against-live-set pattern in lib/hiddenPanels.ts so the store
   * doesn't accumulate one `PanelTrace` per panel ever traced. */
  prune(liveIds: Set<string>): void {
    for (const id of this.panels.keys()) {
      if (!liveIds.has(id)) this.forget(id);
    }
  }

  isTracing(panelId: string): boolean {
    return this.panels.get(panelId)?.tracing ?? false;
  }

  setTracing(panelId: string, on: boolean): void {
    const e = this.entry(panelId);
    if (e.tracing === on) return;
    e.tracing = on;
    this.notify(panelId);
  }

  subscribe(panelId: string, fn: () => void): () => void {
    const e = this.entry(panelId);
    e.listeners.add(fn);
    return () => {
      e.listeners.delete(fn);
    };
  }
}

export type TraceStore = TraceStoreImpl;

// Module-scope singleton. The context exists so tests can swap stores
// if they need to; the production app uses the singleton.
const singleton = new TraceStoreImpl();
const TraceStoreContext = createContext<TraceStoreImpl>(singleton);

export function TraceProvider({ children }: { children: ReactNode }) {
  return <TraceStoreContext.Provider value={singleton}>{children}</TraceStoreContext.Provider>;
}

export function useTraceStore(): TraceStore {
  return useContext(TraceStoreContext);
}

export function useTracingFlag(panelId: string): boolean {
  const store = useTraceStore();
  return useSyncExternalStore(
    (fn) => store.subscribe(panelId, fn),
    () => store.isTracing(panelId),
    () => false,
  );
}

export function usePanelTrace(panelId: string): PanelTrace | undefined {
  const store = useTraceStore();
  return useSyncExternalStore(
    (fn) => store.subscribe(panelId, fn),
    () => store.get(panelId),
    () => undefined,
  );
}
