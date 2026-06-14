import type { Event } from '@server/parser.ts';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LightboxProvider } from '../lib/lightbox.tsx';
import type { PanelState } from '../useDeltaStream.ts';
import { PanelCard } from './PanelCard.tsx';

let uid = 0;
function ev<K extends Event['kind']>(
  kind: K,
  payload: Extract<Event, { kind: K }>['payload'],
): Event {
  uid += 1;
  return {
    kind,
    payload,
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 'p1',
    agent_id: null,
    ts: '2026-05-19T00:00:00Z',
    cwd: null,
  } as Event;
}

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

function renderPanel(p: PanelState) {
  return render(
    <LightboxProvider>
      <PanelCard panel={p} />
    </LightboxProvider>,
  );
}

describe('<PanelCard>', () => {
  it('renders the panel title', () => {
    const { container } = renderPanel(panel({ title: 'my session' }));
    expect(container.querySelector('.panel-title')?.textContent).toBe('my session');
  });

  it('carries the status- class for the current panel status', () => {
    const { container } = renderPanel(panel({ status: 'done' }));
    expect(container.querySelector('.panel')).toHaveClass('status-done');
  });

  it('renders the cwd-derived project label in the subtitle', () => {
    const { container } = renderPanel(panel({ cwd: '/Users/mike/src/brainhouse' }));
    expect(container.querySelector('.panel-subtitle')?.textContent).toBe('brainhouse');
  });

  it('renders the green status light while status is live', () => {
    const { container } = renderPanel(panel({ status: 'live' }));
    // Live state is now communicated via the status icon (green LED) rather
    // than a textual "live" badge.
    expect(container.querySelector('.panel.status-live .panel-status-icon')).toBeInTheDocument();
  });

  it('shows the account badge when the parent passes an account prop', () => {
    // account is passed via the `account` prop, not derived from panel state —
    // App.tsx only sets it when >1 account is configured (showAccountBadges).
    const { container } = render(
      <LightboxProvider>
        <PanelCard panel={panel()} account="work" />
      </LightboxProvider>,
    );
    expect(container.querySelector('.panel-account')?.textContent).toBe('work');
  });

  it('renders the waiting badge when a user_text is pending an assistant reply', () => {
    const { container } = renderPanel(
      panel({ status: 'live', events: [ev('user_text', { text: 'help?' })] }),
    );
    expect(container.querySelector('.panel-waiting-badge')).toBeInTheDocument();
  });

  it('does not render the waiting badge when the assistant has responded', () => {
    const { container } = renderPanel(
      panel({
        status: 'live',
        events: [ev('user_text', { text: 'q' }), ev('assistant_text', { text: 'a' })],
      }),
    );
    expect(container.querySelector('.panel-waiting-badge')).toBeNull();
  });

  it('renders the "session ended" footer when status is not live', () => {
    const { container } = renderPanel(panel({ status: 'done' }));
    expect(container.querySelector('.session-ended')).toBeInTheDocument();
  });

  it('idle (done) panels do NOT get the ended class — just status-done', () => {
    const { container } = renderPanel(panel({ status: 'done', ended: false }));
    expect(container.querySelector('.panel')).not.toHaveClass('ended');
    expect(container.querySelector('.panel')).toHaveClass('status-done');
  });

  it('explicitly-ended panels get the .ended class for dimming', () => {
    const { container } = renderPanel(panel({ status: 'done', ended: true }));
    expect(container.querySelector('.panel')).toHaveClass('ended');
  });
});

function renderTrayPanel(p: PanelState) {
  return render(
    <LightboxProvider>
      <PanelCard panel={p} onRestore={() => {}} />
    </LightboxProvider>,
  );
}

describe('tray render mode', () => {
  // The tray holds three kinds of panels: server-mini, allocator-overflow
  // (server status still live/done), and client-mini'd. All of them must
  // render as minis — the render mode keys on tray placement (`onRestore`
  // is only supplied by the tray renderer), not on server lifecycle.
  it('a done-status tray panel gets the mini hover toolbar, not the tool palette', () => {
    const { container } = renderTrayPanel(panel({ status: 'done' }));
    expect(container.querySelector('.mini-hover-toolbar')).toBeInTheDocument();
    expect(container.querySelector('.panel-tool-palette')).toBeNull();
  });

  it('a live-status tray panel renders mini while keeping its live lifecycle class', () => {
    const { container } = renderTrayPanel(panel({ status: 'live' }));
    expect(container.querySelector('.panel')).toHaveClass('render-mini');
    expect(container.querySelector('.panel')).toHaveClass('status-live');
    expect(container.querySelector('.mini-hover-toolbar')).toBeInTheDocument();
  });

  it('a server-mini tray panel keeps status-mini (off LED) plus render-mini', () => {
    const { container } = renderTrayPanel(panel({ status: 'mini' }));
    expect(container.querySelector('.panel')).toHaveClass('status-mini');
    expect(container.querySelector('.panel')).toHaveClass('render-mini');
  });

  it('a mini-status panel mounted in the grid (no onRestore) still renders full', () => {
    const { container } = renderPanel(panel({ status: 'mini' }));
    expect(container.querySelector('.panel')).toHaveClass('status-done');
    expect(container.querySelector('.panel')).not.toHaveClass('render-mini');
    expect(container.querySelector('.mini-hover-toolbar')).toBeNull();
  });
});
