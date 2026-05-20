import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TransformsModal } from './TransformsModal.tsx';

describe('<TransformsModal>', () => {
  it('renders an entry for every documented transform', () => {
    const { container } = render(<TransformsModal />);
    const items = container.querySelectorAll('.transforms-item');
    // 10 named transforms today; this assertion locks the count so adding a
    // new transform without updating the modal trips the test.
    expect(items.length).toBe(10);
  });

  it('groups entries by stage (pass-1 vs pass-2)', () => {
    const { container } = render(<TransformsModal />);
    expect(container.querySelectorAll('.transforms-pass-1').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.transforms-pass-2').length).toBeGreaterThan(0);
  });

  it('mentions key transforms by name', () => {
    render(<TransformsModal />);
    for (const needle of [
      /mergeToolResultIntoCapsule/,
      /AskUserQuestion/,
      /suppressInterruptMarker/,
      /coalesceFileOps/,
      /coalesceBetweenChats/,
    ]) {
      expect(screen.getAllByText(needle).length).toBeGreaterThan(0);
    }
  });
});
