import type { Event } from '@server/parser.ts';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LightboxProvider } from '../lib/lightbox.tsx';
import type { PanelState } from '../useDeltaStream.ts';

// Count EventList renders so we can prove the 1Hz clock tick does not drag
// the (expensive, unmemoized) event subtree through render + repaint. This is
// the root-cause guard for the renderer-native paint/raster memory leak: when
// the per-second `now` lived in PanelCard, every tick re-rendered the whole
// panel — including EventList — ×35 panels/sec.
const mockEventList = vi.hoisted(() => ({ renders: 0 }));
vi.mock('./EventList.tsx', () => ({
  EventList: () => {
    mockEventList.renders += 1;
    return null;
  },
}));

import { PanelCard } from './PanelCard.tsx';

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
    events: [] as Event[],
    ...overrides,
  } as PanelState;
}

describe('PanelCard clock isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    mockEventList.renders = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates the idle label on a tick WITHOUT re-rendering EventList', () => {
    const { container } = render(
      <LightboxProvider>
        <PanelCard panel={panel({ status: 'live', last_event_at: Date.now() / 1000 })} />
      </LightboxProvider>,
    );

    const rendersAfterMount = mockEventList.renders;
    const labelBefore = container.querySelector('.panel-idle')?.textContent;
    expect(labelBefore).toBe('0s');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // The clock must still drive the header's idle counter...
    expect(container.querySelector('.panel-idle')?.textContent).toBe('3s');
    // ...but the tick must NOT re-render the event body.
    expect(mockEventList.renders).toBe(rendersAfterMount);
  });
});
