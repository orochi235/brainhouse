import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelState } from '../useDeltaStream.ts';
import { IdleCell } from './ProcessRow.tsx';

// Root-cause guard for the renderer-native paint/raster memory leak: the
// process table's per-row Idle column must be driven by a LEAF clock
// subscription (lib/clock.ts), never by a per-second `now` state up in
// ProcessesPanel. A panel-level tick re-renders + repaints the whole
// (large) table every second, churning PartitionAlloc raster tiles into a
// high-water mark that never returns. This proves only the cell re-renders.

function panel(overrides: Partial<PanelState> = {}): PanelState {
  return {
    id: 'p1',
    kind: 'parent',
    parent_panel_id: null,
    title: 'a session',
    agent_type: null,
    task_description: null,
    account_label: null,
    status: 'live',
    started_at: 0,
    last_event_at: Date.now() / 1000,
    status_changed_at: 0,
    event_count: 0,
    cwd: '/Users/mike/src/brainhouse',
    theme: null,
    binned_at: null,
    awaiting_input: false,
    ended: false,
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    events: [],
    ...overrides,
  } as PanelState;
}

describe('ProcessRow Idle cell clock isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates the idle label on a tick WITHOUT re-rendering its parent', () => {
    let parentRenders = 0;
    function Harness() {
      parentRenders += 1;
      return (
        <table>
          <tbody>
            <tr>
              <IdleCell panel={panel({ last_event_at: Date.now() / 1000 })} />
            </tr>
          </tbody>
        </table>
      );
    }

    const { container } = render(<Harness />);
    const rendersAfterMount = parentRenders;
    expect(container.querySelector('.process-idle')?.textContent).toBe('0s');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // The shared clock still drives the idle counter...
    expect(container.querySelector('.process-idle')?.textContent).toBe('3s');
    // ...but the tick must NOT re-render the parent (the table/row subtree).
    expect(parentRenders).toBe(rendersAfterMount);
  });
});
