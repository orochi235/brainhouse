import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectorStoreProvider } from '../transforms/selectors/store.tsx';
import { TransformsModal } from './TransformsModal.tsx';

function frame() {
  return render(
    <SelectorStoreProvider>
      <TransformsModal />
    </SelectorStoreProvider>,
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
    expect(screen.getByRole('tab', { name: /types/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
