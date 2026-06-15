/**
 * Per-panel transform toggle hook. Disabled transforms are skipped by
 * `runViewPipeline` via its `isEnabled` predicate (see `runner.ts`).
 * State persists in `localStorage`, scoped per panel so a transform
 * disabled while debugging one conversation doesn't leak across panels.
 *
 * Key shape: `bh.transforms.toggles.v1:${panelId}`. Default for any key
 * not present in the stored object is `true` (enabled).
 */

import { useCallback, useSyncExternalStore } from 'react';

const LS_PREFIX = 'bh.transforms.toggles.v1:';

export type ToggleMap = Record<string, boolean>;

interface PanelState {
  map: ToggleMap;
  listeners: Set<() => void>;
}

const panels = new Map<string, PanelState>();

function lsKey(panelId: string): string {
  return `${LS_PREFIX}${panelId}`;
}

function load(panelId: string): ToggleMap {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(lsKey(panelId)) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const out: ToggleMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'boolean') out[k] = v;
      }
      return out;
    }
  } catch {
    // ignore corrupt storage
  }
  return {};
}

function save(panelId: string, map: ToggleMap): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (Object.keys(map).length === 0) localStorage.removeItem(lsKey(panelId));
    else localStorage.setItem(lsKey(panelId), JSON.stringify(map));
  } catch {
    // ignore quota / disabled storage
  }
}

function getState(panelId: string): PanelState {
  let s = panels.get(panelId);
  if (!s) {
    s = { map: load(panelId), listeners: new Set() };
    panels.set(panelId, s);
  }
  return s;
}

function notify(panelId: string): void {
  const s = panels.get(panelId);
  if (!s) return;
  for (const fn of s.listeners) fn();
}

export interface TransformToggles {
  isEnabled: (key: string) => boolean;
  set: (key: string, enabled: boolean) => void;
  all: ToggleMap;
  resetAll: () => void;
}

/** React hook: subscribe to the toggle map for `panelId`. The returned
 * `isEnabled` reference is stable per panel state snapshot so it's safe
 * to pass into `runViewPipeline` from a `useMemo` deps array. */
export function useTransformToggles(panelId: string): TransformToggles {
  const subscribe = useCallback(
    (fn: () => void) => {
      const s = getState(panelId);
      s.listeners.add(fn);
      return () => {
        s.listeners.delete(fn);
      };
    },
    [panelId],
  );
  const getSnapshot = useCallback(() => getState(panelId).map, [panelId]);
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isEnabled = useCallback(
    (key: string) => {
      const v = map[key];
      return v === undefined ? true : v;
    },
    [map],
  );
  const set = useCallback(
    (key: string, enabled: boolean) => {
      const s = getState(panelId);
      const next: ToggleMap = { ...s.map };
      // Drop the entry when restoring the default to keep storage tidy.
      if (enabled) delete next[key];
      else next[key] = false;
      s.map = next;
      save(panelId, next);
      notify(panelId);
    },
    [panelId],
  );
  const resetAll = useCallback(() => {
    const s = getState(panelId);
    s.map = {};
    save(panelId, {});
    notify(panelId);
  }, [panelId]);

  return { isEnabled, set, all: map, resetAll };
}

/** Non-hook accessor for tests + the runner adapter when no component
 * is mounted. Avoid in render code; prefer `useTransformToggles`. */
export function readToggles(panelId: string): ToggleMap {
  return getState(panelId).map;
}

/** Drop in-memory toggle state for panels the server has forgotten.
 * The module Map otherwise gains an entry (plus a listener set) per
 * panel ever mounted and never sheds it. localStorage is left intact,
 * so the toggles re-hydrate via `load()` if the same panel id ever
 * comes back. Entries that are still subscribed are left wired. */
export function pruneToggles(liveIds: Set<string>): void {
  for (const [id, s] of panels) {
    if (liveIds.has(id) || s.listeners.size > 0) continue;
    panels.delete(id);
  }
}

/** Test-only: drop all in-module state. */
export function __resetTogglesForTests(): void {
  panels.clear();
  try {
    if (typeof localStorage === 'undefined') return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
