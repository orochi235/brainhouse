import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TypesTab } from './TypesTab.tsx';

function renderTab(props: Partial<React.ComponentProps<typeof TypesTab>> = {}) {
  const onSelect = vi.fn();
  const onJump = vi.fn();
  const utils = render(
    <SelectorStoreProvider>
      <TypesTab selectedKey={null} onSelect={onSelect} onJumpToTransform={onJump} {...props} />
    </SelectorStoreProvider>,
  );
  return { ...utils, onSelect, onJump };
}

describe('<TypesTab>', () => {
  it('renders one row per selector by default', () => {
    renderTab();
    expect(screen.getByText('TodoWrite tool_use')).toBeInTheDocument();
    expect(screen.getByText('Bash tool_use')).toBeInTheDocument();
    expect(screen.getByText('Queue-operation meta')).toBeInTheDocument();
  });

  it('filters rows by search across name/key/source/description', () => {
    renderTab();
    fireEvent.change(screen.getByPlaceholderText(/search types/i), {
      target: { value: 'todowrite' },
    });
    expect(screen.getByText('TodoWrite tool_use')).toBeInTheDocument();
    expect(screen.queryByText('Queue-operation meta')).not.toBeInTheDocument();
  });

  it('calls onSelect when a row is clicked', () => {
    const { onSelect } = renderTab();
    const row = screen.getByText('Bash tool_use').closest('button');
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('tool-use.bash');
  });

  it('renders the detail empty state when nothing is selected', () => {
    renderTab();
    expect(screen.getByText(/select a type/i)).toBeInTheDocument();
  });

  it('renders the detail panel for a selected key', () => {
    renderTab({ selectedKey: 'tool-use.bash' });
    expect(
      screen.getByRole('heading', { level: 4, name: /bash tool_use/i }),
    ).toBeInTheDocument();
  });
});
