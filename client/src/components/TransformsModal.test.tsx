import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VIEW_TRANSFORMS } from '../transforms/registry.ts';
import { TraceProvider } from '../transforms/traceContext.tsx';
import { TransformsModal } from './TransformsModal.tsx';

describe('<TransformsModal>', () => {
  it('renders an entry for every registered transform', () => {
    const { container } = render(<TransformsModal />);
    const items = container.querySelectorAll('.transforms-item');
    expect(items.length).toBe(VIEW_TRANSFORMS.length);
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

  it('hides the Trace tab when no panel context is provided', () => {
    const { container } = render(<TransformsModal />);
    expect(container.querySelector('.transforms-tab-strip')).toBeNull();
  });

  it('exposes a Trace tab when called with panel context', () => {
    render(
      <TraceProvider>
        <TransformsModal panelId="p1" events={[]} items={[]} />
      </TraceProvider>,
    );
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Trace' })).toBeTruthy();
  });
});
