/**
 * Resizable dock that holds the DebugTile at the bottom of the main
 * workarea (below the session grid) when debug mode is active. A thin
 * drag handle along its top edge lets the user grow/shrink the strip;
 * the height is clamped to the available main-area height and persisted
 * to localStorage.
 *
 * The session grid above is a flex:1 sibling, so it reflows into
 * whatever vertical space the strip doesn't take. We deliberately do
 * NOT express this as a windease binarySplit: that strategy requires
 * exactly two visible children per level, so toggling debug on/off would
 * mean restructuring the layout store tree each time. A self-contained
 * splitter keeps the debug-only surface isolated from the core layout.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const DEBUG_STRIP_MIN_PX = 120;
/** Strip may grow to at most this fraction of the main area, so the
 * session grid above always keeps a usable remainder. */
export const STRIP_MAX_FRACTION = 0.7;

const STRIP_HEIGHT_KEY = 'brainhouse:debug:stripHeight';
const DEFAULT_STRIP_PX = 280;

/** Clamp a desired strip height to [MIN, fraction·container]. The floor
 * wins when the container is so short that the fraction would fall below
 * MIN, so the handle stays grabbable. */
export function clampStripHeight(h: number, containerH: number): number {
  const max = Math.max(DEBUG_STRIP_MIN_PX, containerH * STRIP_MAX_FRACTION);
  return Math.min(max, Math.max(DEBUG_STRIP_MIN_PX, h));
}

export function saveStripHeight(h: number): void {
  try { localStorage.setItem(STRIP_HEIGHT_KEY, String(Math.round(h))); } catch {}
}

/** Read the persisted height (or the default) and re-clamp it against the
 * current container — a stored height from a taller viewport shouldn't
 * eat the whole grid after a resize. */
export function loadStripHeight(containerH: number): number {
  let stored = NaN;
  try { stored = parseFloat(localStorage.getItem(STRIP_HEIGHT_KEY) ?? ''); } catch {}
  const base = Number.isFinite(stored) ? stored : DEFAULT_STRIP_PX;
  return clampStripHeight(base, containerH);
}

export function DebugDock({ children }: { children: ReactNode }) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  // Seed from the persisted value using the viewport as a stand-in for
  // the not-yet-measured container; the mount effect below re-clamps once
  // the real container height is known.
  const [height, setHeight] = useState(() =>
    loadStripHeight(typeof window !== 'undefined' ? window.innerHeight : DEFAULT_STRIP_PX),
  );

  /** The flex column (`.main-stack`) that holds the grid + this dock. Its
   * height is the budget the strip is clamped against. A 0 measurement
   * (pre-layout mount tick) would otherwise collapse the strip to its
   * floor, so fall back to the viewport height until a real height lands. */
  const containerH = () => {
    const h = handleRef.current?.parentElement?.clientHeight ?? 0;
    return h > 0 ? h : window.innerHeight;
  };

  useEffect(() => {
    setHeight((h) => clampStripHeight(h, containerH()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const budget = containerH();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      // Drag up (clientY decreases) grows the strip.
      const next = clampStripHeight(startHeight + (startY - ev.clientY), budget);
      setHeight(next);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      setHeight((h) => { saveStripHeight(h); return h; });
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  return (
    <>
      <div
        ref={handleRef}
        className="debug-strip-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize debug panel"
        onPointerDown={onPointerDown}
      />
      <div className="debug-strip" style={{ height: `${height}px` }}>
        {children}
      </div>
    </>
  );
}
