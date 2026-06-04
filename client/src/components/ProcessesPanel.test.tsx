import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProcessesPanel } from './ProcessesPanel.tsx';

vi.mock('../useProcesses.ts', () => ({
  useProcesses: () => [
    { process_id: 'p1', host: 'local', pid: 100, ppid: 1, start_ts: 0,
      command: 'node vite', cwd: '/proj', session_id: 's1',
      hook_command: 'npm run dev', run_in_background: true,
      provenance: 'hooked', runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path',
      framework: 'vite', framework_version: '5.4.2',
      ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }],
      ended_ts: null, ended_reason: null, uptime_s: 724 },
  ],
}));

describe('ProcessesPanel', () => {
  it('renders one row per process with key columns', () => {
    render(<ProcessesPanel allPanels={new Map()} />);
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText(/vite/)).toBeInTheDocument();
    expect(screen.getByText(/5173/)).toBeInTheDocument();
  });
});
