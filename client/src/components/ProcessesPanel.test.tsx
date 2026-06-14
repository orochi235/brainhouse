import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessesPanel } from './ProcessesPanel.tsx';

vi.mock('../useProcesses.ts', () => ({
  useProcesses: () => [
    { process_id: 'p1', host: 'local', pid: 100, ppid: 1, start_ts: 0,
      command: 'node vite', cwd: '/proj', session_id: 's1',
      hook_command: 'npm run dev', run_in_background: true,
      provenance: 'hooked', runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path',
      framework: 'vite', framework_version: '5.4.2',
      ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }],
      ended_ts: null, ended_reason: null, uptime_s: 724,
      bash_id: null, project: null, account_label: null, original_ancestors: [] },
  ],
}));

describe('ProcessesPanel', () => {
  it('renders a port-binding process row with key columns in Network view', async () => {
    render(<ProcessesPanel allPanels={new Map()} />);
    // The fixture is a dev server bound to :5173 with no Claude ancestor,
    // so it lives in Network view — the Sessions tree only shows Claude
    // sessions and their descendants. The Ports column is network-only too.
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /network/i }));
    expect(screen.getByText('100')).toBeInTheDocument(); // PID
    expect(screen.getByText('node vite')).toBeInTheDocument(); // Command
    expect(screen.getByText('vite 5.4.2')).toBeInTheDocument(); // Framework (network-only)
    expect(screen.getByText(/5173/)).toBeInTheDocument(); // Ports (network-only)
  });
});
