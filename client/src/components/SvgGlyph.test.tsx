import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SvgGlyph } from './SvgGlyph.tsx';

describe('SvgGlyph', () => {
  it('renders the svg markup as inner HTML with the class', () => {
    const { container } = render(<SvgGlyph svg="<svg><path/></svg>" className="op-strip-mini-icon svg-glyph" />);
    const span = container.querySelector('span.svg-glyph');
    expect(span).not.toBeNull();
    expect(span?.querySelector('svg path')).not.toBeNull();
  });

  it('reuses the SVG DOM node across a parent re-render with identical markup', () => {
    // The whole point of the memo: identical markup must not rebuild the SVG
    // subtree (the churn that ratchets native memory). If memo skips the
    // re-render, React never touches the span, so the inner <svg> node is the
    // same instance before and after.
    function Parent({ tick }: { tick: number }) {
      return (
        <div data-tick={tick}>
          <SvgGlyph svg="<svg><path/></svg>" className="svg-glyph" />
        </div>
      );
    }
    const { container, rerender } = render(<Parent tick={1} />);
    const before = container.querySelector('svg');
    rerender(<Parent tick={2} />);
    const after = container.querySelector('svg');
    expect(after).toBe(before);
  });
});
