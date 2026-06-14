/**
 * Basic in-renderer memory telemetry.
 *
 * Motivation: the brainhouse tab creeps toward multi-GB process footprint
 * while the JS heap stays small (~150 MB) — i.e. the growth is *not* JS. A
 * browser tab can't read its own process RSS, so we sample the signals
 * that JS *can* see and that track a non-JS renderer leak:
 *
 *   - JS heap (performance.memory — Chromium only)
 *   - total DOM node count (detached/!accumulating DOM is the classic
 *     "footprint grows, JS heap doesn't" culprit)
 *   - counts of the heavy element kinds brainhouse renders a lot of
 *     (panels, event rows, images, canvases)
 *   - measureUserAgentSpecificMemory() breakdown WHEN available — it needs
 *     crossOriginIsolation (COOP/COEP), which we don't set today, so it's
 *     wired up but inert for now.
 *
 * Samples land in a ring buffer and are logged at console.debug under the
 * `[mem]` tag. `window.__mem` exposes the buffer for inspection/export:
 *   __mem.dump()   → CSV string (paste into a sheet to chart the creep)
 *   __mem.samples()→ the raw rows
 *   __mem.clear()  → reset
 */

export interface MemSample {
  /** seconds since the renderer loaded (performance.timeOrigin). */
  t: number;
  jsUsedMB: number | null;
  jsTotalMB: number | null;
  domNodes: number;
  panels: number;
  eventRows: number;
  images: number;
  canvases: number;
  /** measureUserAgentSpecificMemory() total, MB — null unless the API is
   * available (cross-origin isolated). Backfilled async after the sample. */
  uaMemMB: number | null;
}

const RING_MAX = 5000;
const ring: MemSample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function mb(bytes: number): number {
  return Math.round((bytes / 1048576) * 10) / 10;
}

function takeSample(): MemSample {
  const mem = (performance as Performance & { memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
  } }).memory;
  return {
    t: Math.round(Math.max(0, performance.now() / 1000)),
    jsUsedMB: mem ? mb(mem.usedJSHeapSize) : null,
    jsTotalMB: mem ? mb(mem.totalJSHeapSize) : null,
    domNodes: document.getElementsByTagName('*').length,
    panels: document.querySelectorAll('.panel').length,
    eventRows: document.querySelectorAll('[data-event-uuid]').length,
    images: document.querySelectorAll('img').length,
    canvases: document.querySelectorAll('canvas').length,
    uaMemMB: null,
  };
}

/** Best-effort detailed breakdown — only resolves where the API exists
 * (cross-origin isolated contexts). Backfills the sample in place. */
function backfillUaMem(sample: MemSample): void {
  const measure = (
    performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    }
  ).measureUserAgentSpecificMemory;
  if (typeof measure !== 'function') return;
  measure
    .call(performance)
    .then((r) => {
      sample.uaMemMB = mb(r.bytes);
    })
    .catch(() => {});
}

function dump(): string {
  const cols: (keyof MemSample)[] = [
    't', 'jsUsedMB', 'jsTotalMB', 'domNodes', 'panels', 'eventRows', 'images', 'canvases', 'uaMemMB',
  ];
  const head = cols.join(',');
  const rows = ring.map((s) => cols.map((c) => s[c] ?? '').join(','));
  return [head, ...rows].join('\n');
}

/**
 * Start sampling memory every `intervalMs`. Idempotent — a second call is a
 * no-op and returns the same stop handle. Returns a stop function.
 */
export function startMemTelemetry(intervalMs = 15000): () => void {
  if (timer) return stopMemTelemetry;
  const tick = () => {
    const s = takeSample();
    ring.push(s);
    if (ring.length > RING_MAX) ring.shift();
    backfillUaMem(s);
    // console.debug so it stays out of the default console view; filter by [mem].
    console.debug(
      `[mem] t=${s.t}s js=${s.jsUsedMB}/${s.jsTotalMB}MB dom=${s.domNodes} panels=${s.panels} events=${s.eventRows} img=${s.images} canvas=${s.canvases}`,
    );
  };
  tick();
  timer = setInterval(tick, intervalMs);
  (globalThis as { __mem?: unknown }).__mem = {
    samples: () => ring.slice(),
    dump,
    clear: () => {
      ring.length = 0;
    },
  };
  return stopMemTelemetry;
}

export function stopMemTelemetry(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Latest sample, or null before the first tick. For UI readouts. */
export function latestMemSample(): MemSample | null {
  return ring[ring.length - 1] ?? null;
}
