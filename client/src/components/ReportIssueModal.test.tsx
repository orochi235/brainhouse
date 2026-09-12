import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../trpc.ts', () => ({
  trpc: {
    reportIssue: {
      mutate: vi.fn(async () => ({ reportPath: '/reports/r.md', launched: true })),
    },
  },
}));

import { LightboxProvider } from '../lib/lightbox.tsx';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';
import { ReportIssueModal } from './ReportIssueModal.tsx';

const panel = {
  id: 'aac37d1e119bac1ee',
  kind: 'subagent',
  parent_panel_id: '59abb1c3',
  title: 'Lab: yaw, depth shading',
  agent_type: 'general-purpose',
  cwd: '/Users/mike/src/blitsklieg',
  repo_root: '/Users/mike/src/blitsklieg',
} as PanelState;

function renderModal() {
  return render(
    <LightboxProvider>
      <ReportIssueModal panel={panel} />
    </LightboxProvider>,
  );
}

describe('<ReportIssueModal>', () => {
  beforeEach(() => {
    vi.mocked(trpc.reportIssue.mutate).mockClear();
  });

  it('names the panel it will file against', () => {
    renderModal();
    expect(screen.getByText('Lab: yaw, depth shading')).toBeInTheDocument();
    expect(screen.getByText('blitsklieg')).toBeInTheDocument();
    expect(screen.getByText('aac37d1e119bac1ee')).toBeInTheDocument();
  });

  it('disables Report until something is typed', async () => {
    renderModal();
    const report = screen.getByRole('button', { name: 'Report' });
    expect(report).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), 'the label is missing');
    expect(report).toBeEnabled();
  });

  it('stays disabled for whitespace-only input', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox'), '   ');
    expect(screen.getByRole('button', { name: 'Report' })).toBeDisabled();
  });

  it('sends the panel id and the typed text', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox'), 'no project label');
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() =>
      expect(trpc.reportIssue.mutate).toHaveBeenCalledWith({
        panelId: 'aac37d1e119bac1ee',
        text: 'no project label',
      }),
    );
  });

  it('keeps the report visible when the terminal could not be opened', async () => {
    vi.mocked(trpc.reportIssue.mutate).mockResolvedValueOnce({
      reportPath: '/reports/r.md',
      launched: false,
    });
    renderModal();
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/no iTerm2 window opened/)).toBeInTheDocument();
    expect(screen.getByText('/reports/r.md')).toBeInTheDocument();
  });

  it('names why the terminal could not be opened when the server says', async () => {
    vi.mocked(trpc.reportIssue.mutate).mockResolvedValueOnce({
      reportPath: '/reports/r.md',
      launched: false,
      error: 'Not authorized to send Apple events to iTerm2. (-1743)',
    });
    renderModal();
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/-1743/)).toBeInTheDocument();
  });

  it('surfaces a server error instead of closing', async () => {
    vi.mocked(trpc.reportIssue.mutate).mockRejectedValueOnce(new Error('server down'));
    renderModal();
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/server down/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('x');
  });
});
