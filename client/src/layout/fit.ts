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
