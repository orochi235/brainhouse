import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MiniHoverToolbar } from './MiniHoverToolbar.tsx';

describe('MiniHoverToolbar', () => {
  it('renders three buttons with accessible labels', () => {
    render(
      <MiniHoverToolbar
        onRestore={() => {}}
        onPinToMinibar={() => {}}
        onTrash={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pin/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /trash|remove/i })).toBeInTheDocument();
  });

  it('invokes the matching handler on click', async () => {
    const onRestore = vi.fn();
    const onPinToMinibar = vi.fn();
    const onTrash = vi.fn();
    render(
      <MiniHoverToolbar
        onRestore={onRestore}
        onPinToMinibar={onPinToMinibar}
        onTrash={onTrash}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /restore/i }));
    await user.click(screen.getByRole('button', { name: /pin/i }));
    await user.click(screen.getByRole('button', { name: /trash|remove/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onPinToMinibar).toHaveBeenCalledTimes(1);
    expect(onTrash).toHaveBeenCalledTimes(1);
  });

  it('stops click propagation so the parent row click handler does not fire', async () => {
    const onRowClick = vi.fn();
    const onRestore = vi.fn();
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: test fixture.
      <div onClick={onRowClick}>
        <MiniHoverToolbar
          onRestore={onRestore}
          onPinToMinibar={() => {}}
          onTrash={() => {}}
        />
      </div>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
