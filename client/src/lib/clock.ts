import { useSyncExternalStore } from 'react';

/**
 * A single app-wide 1Hz clock.
 *
 * Elapsed/relative-time displays (idle counters, thinking timers, checklist
 * durations) need to re-render once per second. The naive approach — a
 * `setInterval` + `useState` inside each PanelCard — is a renderer-native
 * memory leak at scale: it re-renders the *whole* panel (including the large,
 * unmemoized EventList subtree) every second, ×N panels, churning paint/raster
 * tiles that PartitionAlloc's high-water mark never returns.
 *
 * Instead, only the small leaf components that actually display time subscribe
 * via `useClock()`. They re-render each tick; their parents (PanelCard →
 * EventList) do not. One timer for the whole app instead of one per panel.
 */
let nowSeconds = Date.now() / 1000;
const subscribers = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  // Refresh on each new subscriber so a component mounting long after app load
  // (when `nowSeconds` may be stale between ticks) gets a current first value.
  // React re-reads the snapshot right after subscribing, so this corrects the
  // initial render before paint without a visible flash.
  nowSeconds = Date.now() / 1000;
  subscribers.add(onChange);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      nowSeconds = Date.now() / 1000;
      for (const cb of subscribers) cb();
    }, 1000);
  }
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): number {
  return nowSeconds;
}

/** Wall-clock seconds (float), updated once per second from a single shared
 * timer. The calling component re-renders each tick; its parent does not. */
export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
