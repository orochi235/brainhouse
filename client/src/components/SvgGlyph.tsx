import { memo } from 'react';

/**
 * Renders bundled SVG icon markup via `dangerouslySetInnerHTML`, memoized on
 * the `svg` string.
 *
 * Why memo matters: callers (`ToolCapsule`, op-strip `GroupIcon`, timeline,
 * etc.) recompute their icon objects on every render, and the per-second
 * panel tick re-renders all of them. Without memoization React re-applies
 * `dangerouslySetInnerHTML`, which tears down and rebuilds the icon's SVG
 * subtree each time. Across many panels that churns tens of thousands of
 * detached DOM nodes per second — and the renderer's native allocator commits
 * that memory and never returns it, so the tab's footprint ratchets into the
 * gigabytes. Memoizing on the (stable, build-time) markup string means
 * identical icons never re-render, so the SVG nodes are built once and reused.
 */
export const SvgGlyph = memo(function SvgGlyph({
  svg,
  className,
}: {
  svg: string;
  className?: string;
}) {
  return (
    <span
      className={className}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
