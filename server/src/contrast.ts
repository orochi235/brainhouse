/** WCAG 2.1 contrast for `#rgb`/`#rrggbb` pairs. The client's
 * `client/src/lib/contrast.ts` holds the same math; the two packages share
 * no source yet. */

function luminance(hex: string): number | null {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const channel = (i: number) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Contrast ratio 1–21, or null when either color isn't plain hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `background`. */
export function blackOrWhite(background: string): '#000' | '#fff' {
  return (contrastRatio('#000', background) ?? 0) >= (contrastRatio('#fff', background) ?? 0)
    ? '#000'
    : '#fff';
}
