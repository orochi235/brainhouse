/**
 * Picks an integer (cols, rows) tiling for N panels that fills a container
 * of size (w, h) with cells closest to a target aspect ratio. Wide panels
 * occupy two slots, so the caller passes `slots = panels + wideCount`.
 *
 * The score combines two pressures:
 *   - larger cells are better (log of cell area)
 *   - cells whose aspect ratio matches the target are better (log distance)
 *
 * Returned cols ∈ [1, slots]; rows = ceil(slots / cols).
 */

import { useEffect, useRef, useState } from 'react';

/** Target cell aspect (width / height). 1.0 = square; tunable. */
export const TARGET_CELL_ASPECT = 1.0;

/**
 * Pick column count by scoring each candidate on three pressures:
 *   - bigger cells (log of cell area)
 *   - aspect ratio matches target (log-distance penalty)
 *   - prefer tilings with few empty leftover cells (waste penalty)
 *
 * Waste penalty is small enough that prime panel counts still tile rationally
 * (one empty cell is OK), but big enough that 4 panels become 2×2 instead of
 * 3+1 on a wide viewport.
 */
export function computeCols(
  width: number,
  height: number,
  slots: number,
  targetAspect = TARGET_CELL_ASPECT,
): number {
  if (slots <= 1) return 1;
  if (width <= 0 || height <= 0) return 1;
  let bestCols = 1;
  let bestScore = -Infinity;
  for (let c = 1; c <= slots; c++) {
    const r = Math.ceil(slots / c);
    const cellW = width / c;
    const cellH = height / r;
    const aspect = cellW / cellH;
    const aspectPenalty = Math.abs(Math.log(aspect / targetAspect));
    const waste = r * c - slots;
    const score = Math.log(cellW * cellH) - aspectPenalty - 0.5 * waste;
    if (score > bestScore) {
      bestScore = score;
      bestCols = c;
    }
  }
  return bestCols;
}

export function useGridLayout(slots: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(1);
  const [rows, setRows] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recompute = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const c = computeCols(w, h, Math.max(1, slots));
      setCols(c);
      setRows(Math.max(1, Math.ceil(Math.max(1, slots) / c)));
    };
    recompute();
    const obs = new ResizeObserver(recompute);
    obs.observe(el);
    return () => obs.disconnect();
  }, [slots]);

  return { ref, cols, rows };
}
