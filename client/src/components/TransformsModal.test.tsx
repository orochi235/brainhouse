import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectorStoreProvider } from '../transforms/selectors/store.tsx';
import { TraceProvider } from '../transforms/traceContext.tsx';
import { TransformsModal } from './TransformsModal.tsx';

function frame(node = <TransformsModal />) {
  return render(
    <TraceProvider>
      <SelectorStoreProvider>{node}</SelectorStoreProvider>
    </TraceProvider>,
  );
}

describe('<TransformsModal>', () => {
  it('renders the pipeline-inspector title', () => {
    frame();
    expect(screen.getByText(/pipeline inspector/i)).toBeInTheDocument();
  });

  it('renders the three inspector tabs including Trace', () => {
    frame();
    expect(screen.getByRole('tab', { name: /types/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /transforms/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /trace/i })).toBeInTheDocument();
  });

  it('Types tab is selected by default', () => {
    frame();
    expect(screen.getByRole('tab', { name: /types/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('Trace tab is present without panel context (placeholder body)', () => {
    frame();
    expect(screen.getByRole('tab', { name: /trace/i })).toBeInTheDocument();
  });

  it('Trace tab is present when called with panel context', () => {
    frame(<TransformsModal panelId="p1" events={[]} items={[]} />);
    expect(screen.getByRole('tab', { name: /trace/i })).toBeInTheDocument();
  });
});
