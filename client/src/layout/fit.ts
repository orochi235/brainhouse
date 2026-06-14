/**
 * Pure ratio math for the top slot's auto-fit.
 *
 * The root binarySplit only understands a `ratio` (top's fraction of the
 * viewport). To make the top "shrink to fit" we measure its intrinsic
 * content height and convert it to that fraction here. Kept pure + separate
 * from the DOM plumbing in Layout.tsx so the cap/floor behavior is testable.
 */
export interface TopRatioOpts {
  /** Hard floor in px so a too-short mid-load measurement (no rows yet)
   * can't pin the gutter on top of the topbar. */
  minPx: number;
  /** Hard cap as a fraction of the viewport so a long process list scrolls
   * internally instead of starving the workspace below. */
  maxFraction: number;
}

/**
 * Convert a measured natural content height to a binarySplit ratio, clamped
 * to `[minPx, maxFraction*vh]`. Returns null when there's nothing usable to
 * apply yet (no content measured, or no viewport), so callers skip the write.
 */
export function computeTopRatio(naturalH: number, vh: number, opts: TopRatioOpts): number | null {
  if (vh <= 0) return null;
  if (naturalH <= 0) return null;
  const target = Math.max(opts.minPx, naturalH);
  return Math.min(opts.maxFraction, target / vh);
}

/** The two most-recently *applied* ratios, in apply order. Enough history to
 * detect a two-value oscillation. */
export interface FitState {
  last: number | null;
  prev: number | null;
}

/**
 * Stability gate for the top auto-fit's measure→apply loop.
 *
 * The naive loop ("measure content, set the slot to it") is an unstable
 * controller: sizing the slot to its content can flip a rendering side effect
 * (a vertical scrollbar appearing → the flex-wrap header re-wrapping a line)
 * that *changes* the very height we measure. That makes the measurement
 * ping-pong between two values a full line-height apart, which the plain
 * sub-pixel deadband can't damp — the slot twitches forever.
 *
 * This gate damps exactly that: a candidate within `deadband` of the
 * last-applied value is a no-op; a candidate bouncing back to the value
 * applied *two* steps ago is the oscillation — refuse it, hold the taller of
 * the two (so content never clips), and stop reapplying. Genuinely new
 * measurements (a new process row, a window resize) still pass through, so the
 * top keeps auto-fitting. `deadband` is in ratio units.
 */
export function nextFitRatio(
  state: FitState,
  candidate: number,
  deadband: number,
): { apply: number | null; state: FitState } {
  const near = (a: number, b: number) => Math.abs(a - b) < deadband;
  if (state.last !== null && near(candidate, state.last)) return { apply: null, state };
  if (state.prev !== null && near(candidate, state.prev)) {
    // Two-value oscillation: candidate is the value from two steps ago. Hold
    // the taller of the pair instead of bouncing.
    const taller = Math.max(candidate, state.last ?? candidate);
    if (state.last !== null && near(taller, state.last)) return { apply: null, state };
    return { apply: taller, state: { last: taller, prev: state.last } };
  }
  return { apply: candidate, state: { last: candidate, prev: state.last } };
}
