/**
 * WCAG contrast math for chips whose background is computed at runtime
 * (project badges, account badges). Their backgrounds come from a hue
 * hash or a user's `.hued` theme, so no fixed text color is readable on
 * all of them — pick the ink per background instead.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse the color forms we actually generate: `#rgb`, `#rrggbb`, and
 * the space- or comma-separated `hsl()` that worktreeColor/badgeColor
 * emit. Anything else (gradients, `var()`, named colors) is null. */
function parseColor(input: string): Rgb | null {
  const value = input.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((c) => c + c)
            .join('')
        : hex[1];
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    };
  }
  const hsl = value.match(/^hsla?\(\s*([-\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%/i);
  if (hsl?.[1] && hsl[2] !== undefined && hsl[3] !== undefined) {
    return hslToRgb(
      Number.parseFloat(hsl[1]),
      Number.parseFloat(hsl[2]) / 100,
      Number.parseFloat(hsl[3]) / 100,
    );
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** WCAG 2.1 relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. Unparseable colors return 1 so callers
 * treat them as "no contrast information" rather than a pass. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#fff';
const BLACK = '#000';

/**
 * Text color for `background`: white unless it fails `minRatio`, then
 * black. Pure white/black are the endpoints on purpose — whichever of
 * the two wins always clears 4.58:1, so the AA floor holds for every
 * possible background. Unparseable input keeps white.
 */
export function readableInk(background: string, minRatio = 4.5): string {
  const bg = parseColor(background);
  if (!bg) return WHITE;
  const onWhite = contrastRatio(WHITE, background);
  if (onWhite >= minRatio) return WHITE;
  return contrastRatio(BLACK, background) > onWhite ? BLACK : WHITE;
}
