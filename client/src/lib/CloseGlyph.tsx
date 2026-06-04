/** Small inline SVG that replaces the literal `×` character in close
 * buttons. The Unicode multiplication sign doesn't sit on the geometric
 * center of its line box — using an SVG with explicit equal width and
 * height makes alignment deterministic across all the close-button
 * contexts (panel leading, project widget action, etc.).
 *
 * Sized in `em` so it scales with the surrounding font-size; the
 * default 0.6em looks comparable to the previous 1.2rem character at
 * standard zoom. Override via the `size` prop when a specific size is
 * needed. */
export function CloseGlyph({ size = '0.6em' }: { size?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 2 L8 8 M8 2 L2 8" />
    </svg>
  );
}
