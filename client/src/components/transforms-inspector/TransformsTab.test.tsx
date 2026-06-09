import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TransformsTab } from './TransformsTab.tsx';

function renderTab(props: Partial<React.ComponentProps<typeof TransformsTab>> = {}) {
  const onSelect = vi.fn();
  const onJump = vi.fn();
  const utils = render(
    <SelectorStoreProvider>
      <TransformsTab
        selectedKey={null}
        onSelect={onSelect}
        onJumpToType={onJump}
        {...props}
      />
    </SelectorStoreProvider>,
  );
  return { ...utils, onSelect, onJump };
}

describe('<TransformsTab>', () => {
  it('lists VIEW_TRANSFORMS by their built-in keys', () => {
    renderTab();
    expect(screen.getByText('built-in.track-pending')).toBeInTheDocument();
    expect(screen.getByText('built-in.coalesce-file-ops')).toBeInTheDocument();
  });

  it('search filters by case-insensitive substring', () => {
    renderTab();
    fireEvent.change(screen.getByPlaceholderText(/search transforms/i), {
      target: { value: 'coalesce' },
    });
    expect(screen.queryByText('built-in.track-pending')).not.toBeInTheDocument();
    expect(screen.getAllByText(/coalesce/i).length).toBeGreaterThan(0);
  });

  it('renders detail with "no declared match" when matches is undefined', () => {
    renderTab({ selectedKey: 'built-in.track-pending' });
    expect(screen.getByText(/no declared match/i)).toBeInTheDocument();
  });
});
