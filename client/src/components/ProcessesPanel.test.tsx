import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRow } from '../useProcesses.ts';
import { ProcessesPanel } from './ProcessesPanel.tsx';

// Mutable mock so individual tests can drive the process list (a populated
// fixture vs the empty restart-window state).
const mock = vi.hoisted(() => ({ rows: [] as ProcessRow[] }));
vi.mock('../useProcesses.ts', () => ({ useProcesses: () => mock.rows }));

const killMock = vi.hoisted(() => vi.fn());
vi.mock('../trpc.ts', () => ({
  trpc: {
    processes: { kill: { mutate: killMock }, revealInIterm: { mutate: vi.fn() } },
    restore: { mutate: vi.fn() },
  },
}));

const FIXTURE_ROW: ProcessRow = {
  process_id: 'p1',
  host: 'local',
  pid: 100,
  ppid: 1,
  start_ts: 0,
  command: 'node vite',
  cwd: '/proj',
  session_id: 's1',
  hook_command: 'npm run dev',
  run_in_background: true,
  provenance: 'hooked',
  runtime: 'node',
  runtime_version: '22.5.0',
  runtime_source: 'path',
  framework: 'vite',
  framework_version: '5.4.2',
  ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }],
  ended_ts: null,
  ended_reason: null,
  uptime_s: 724,
  bash_id: null,
  project: null,
  account_label: null,
  iterm_session_id: null,
  original_ancestors: [],
};

describe('ProcessesPanel', () => {
  beforeEach(() => {
    mock.rows = [FIXTURE_ROW];
  });

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

  it('promotes the owning session when a row title is clicked', async () => {
    const onOpenSession = vi.fn();
    render(<ProcessesPanel allPanels={new Map()} onOpenSession={onOpenSession} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /network/i }));
    // The session-attributed row's title renders as a button (session_id 's1').
    await user.click(screen.getByRole('button', { name: 'node vite' }));
    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('nests daemon-spawned claude processes under the outermost claude root in Sessions view', async () => {
    // Claude Code's daemon architecture: claude spawns claude
    // (`daemon run` → bg-pty-host → …). Only the outermost claude row
    // should root a tree; the nested claude rows are its descendants,
    // not sibling top-level entries.
    const outer: ProcessRow = {
      ...FIXTURE_ROW,
      process_id: 'c1',
      pid: 200,
      ppid: 1,
      command: 'claude --dangerously-skip-permissions',
      runtime: 'claude',
      framework: null,
      framework_version: null,
      ports: [],
      original_ancestors: [],
    };
    const daemon: ProcessRow = {
      ...outer,
      process_id: 'c2',
      pid: 201,
      ppid: 200,
      command: 'claude daemon run',
      original_ancestors: [200],
    };
    const ptyHost: ProcessRow = {
      ...outer,
      process_id: 'c3',
      pid: 202,
      ppid: 201,
      command: 'claude bg-pty-host',
      original_ancestors: [201, 200],
    };
    mock.rows = [outer, daemon, ptyHost];
    render(<ProcessesPanel allPanels={new Map()} />);
    // Earlier tests may have persisted viewMode=network; pick Sessions
    // explicitly.
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /sessions/i }));
    // Collapsed by default: only the outermost claude row is visible.
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.queryByText('201')).not.toBeInTheDocument();
    expect(screen.queryByText('202')).not.toBeInTheDocument();
    // Expanding the single root reveals the daemon chain nested beneath it.
    await user.click(screen.getByRole('button', { name: 'expand' }));
    expect(screen.getByText('201')).toBeInTheDocument();
    expect(screen.getByText('202')).toBeInTheDocument();
  });

  it("adopts orphaned daemon-infra claude rows under their session's primary root", async () => {
    // A bg-pty-host whose daemon parent died reparents to launchd (ppid 1,
    // no tracked ancestors) but keeps its session_id — it should nest under
    // the session's interactive claude root, not surface as a sibling tree.
    const head: ProcessRow = {
      ...FIXTURE_ROW,
      process_id: 'c1',
      pid: 300,
      ppid: 1,
      command: 'claude --dangerously-skip-permissions',
      runtime: 'claude',
      framework: null,
      framework_version: null,
      ports: [],
      original_ancestors: [],
      session_id: 'sX',
    };
    const orphan: ProcessRow = {
      ...head,
      process_id: 'c2',
      pid: 301,
      command: 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon/x.pty.sock',
    };
    mock.rows = [head, orphan];
    render(<ProcessesPanel allPanels={new Map()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /sessions/i }));
    // One root only; the orphan is hidden until expand.
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.queryByText('301')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'expand' }));
    expect(screen.getByText('301')).toBeInTheDocument();
  });

  it('marks subprocess rows (not the claude root) with the live-sweep class in Sessions view', async () => {
    const root: ProcessRow = {
      ...FIXTURE_ROW,
      process_id: 'c1',
      pid: 400,
      ppid: 1,
      command: 'claude',
      runtime: 'claude',
      framework: null,
      framework_version: null,
      ports: [],
      original_ancestors: [],
    };
    const child: ProcessRow = {
      ...root,
      process_id: 'c2',
      pid: 401,
      ppid: 400,
      command: 'node server.js',
      runtime: 'node',
      original_ancestors: [400],
    };
    mock.rows = [root, child];
    const { container } = render(<ProcessesPanel allPanels={new Map()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /sessions/i }));
    await user.click(screen.getByRole('button', { name: 'expand' }));
    const sweeping = container.querySelectorAll('tr.subprocess-active');
    expect(sweeping).toHaveLength(1);
    expect(sweeping[0]?.textContent).toContain('401');
  });

  it('kills every checked row via the kill-selected button, then clears the selection', async () => {
    const root: ProcessRow = {
      ...FIXTURE_ROW,
      process_id: 'c1',
      pid: 500,
      ppid: 1,
      command: 'claude',
      runtime: 'claude',
      framework: null,
      framework_version: null,
      ports: [],
      original_ancestors: [],
    };
    const child: ProcessRow = {
      ...root,
      process_id: 'c2',
      pid: 501,
      ppid: 500,
      command: 'node server.js',
      runtime: 'node',
      original_ancestors: [500],
    };
    mock.rows = [root, child];
    render(<ProcessesPanel allPanels={new Map()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /sessions/i }));
    await user.click(screen.getByRole('button', { name: 'expand' }));
    // No selection → no kill button.
    expect(screen.queryByRole('button', { name: /kill .* selected/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select PID 500' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select PID 501' }));
    await user.click(screen.getByRole('button', { name: 'kill 2 selected' }));
    expect(killMock).toHaveBeenCalledWith({ process_id: 'c1' });
    expect(killMock).toHaveBeenCalledWith({ process_id: 'c2' });
    // Selection cleared → button gone again.
    expect(screen.queryByRole('button', { name: /kill .* selected/i })).not.toBeInTheDocument();
  });

  it('stays mounted with an empty state when there is no process data (restart window)', () => {
    // Regression: an open panel used to return null when the tracker had no
    // rows yet (e.g. right after a server restart), leaving the topbar toggle
    // "pressed" and a dangling layout resize handle with nothing behind it.
    mock.rows = [];
    const { container } = render(<ProcessesPanel allPanels={new Map()} />);
    expect(container.querySelector('.processes-panel')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for process data/i)).toBeInTheDocument();
  });
});
