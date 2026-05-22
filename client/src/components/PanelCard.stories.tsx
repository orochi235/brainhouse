/**
 * Ladle stories for PanelCard. Covers the visual states that are hard to
 * reproduce live (ended/dimmed, themed, multi-account, waiting), each as
 * an isolated panel without needing the server. Add more stories here as
 * we exercise new states — same fixture shape as `server/src/scenarios.ts`,
 * just rendered standalone instead of pushed through `monitor.ingest()`.
 */

import type { Event } from '@server/parser.ts';
import { LightboxProvider } from '../lib/lightbox.tsx';
import type { PanelState } from '../useDeltaStream.ts';
import { PanelCard } from './PanelCard.tsx';

const NOW = Date.now() / 1000;

function panel(overrides: Partial<PanelState> = {}): PanelState {
  return {
    id: 'demo-panel',
    kind: 'parent',
    parent_panel_id: null,
    title: 'Demo session',
    agent_type: null,
    account_label: null,
    status: 'live',
    started_at: NOW - 600,
    last_event_at: NOW - 5,
    status_changed_at: NOW - 5,
    event_count: 0,
    cwd: '/Users/demo/src/brainhouse',
    theme: null,
    binned_at: null,
    awaiting_input: false,
    ended: false,
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    events: [],
    ...overrides,
  } as PanelState;
}

let nextUid = 0;
function ev<K extends Event['kind']>(
  kind: K,
  payload: Extract<Event, { kind: K }>['payload'],
  tsOffsetSeconds = 0,
): Event {
  nextUid += 1;
  return {
    kind,
    payload,
    uuid: `u${nextUid}`,
    parent_uuid: null,
    session_id: 'demo-panel',
    agent_id: null,
    ts: new Date((NOW + tsOffsetSeconds) * 1000).toISOString(),
    cwd: null,
  } as Event;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 460, height: 360, display: 'flex' }}>
      <LightboxProvider>{children}</LightboxProvider>
    </div>
  );
}

export const Live = () => (
  <Frame>
    <PanelCard
      panel={panel({
        events: [
          ev('user_text', { text: 'help me fix this bug' }, -120),
          ev('assistant_text', { text: 'Let me take a look at the file.' }, -60),
        ],
      })}
    />
  </Frame>
);

export const Waiting = () => (
  <Frame>
    <PanelCard
      panel={panel({
        events: [ev('user_text', { text: 'long-running task: build everything' }, -30)],
      })}
    />
  </Frame>
);

export const Done = () => (
  <Frame>
    <PanelCard
      panel={panel({
        status: 'done',
        status_changed_at: NOW - 90,
        events: [
          ev('user_text', { text: 'done?' }, -180),
          ev('assistant_text', { text: 'Yep — all green.' }, -120),
        ],
      })}
    />
  </Frame>
);

export const Ended = () => (
  <Frame>
    <PanelCard
      panel={panel({
        status: 'done',
        ended: true,
        status_changed_at: NOW - 200,
        events: [ev('assistant_text', { text: 'Wrapping up.' }, -200)],
      })}
    />
  </Frame>
);

export const Themed = () => (
  <Frame>
    <PanelCard
      panel={panel({
        title: 'themed session',
        theme: { background: '#320053', foreground: '#ffffff' },
        events: [
          ev('user_text', { text: 'paint me purple' }, -45),
          ev('assistant_text', { text: 'Applied the .hued theme.' }, -20),
        ],
      })}
    />
  </Frame>
);

export const WithAccountBadge = () => (
  <Frame>
    <PanelCard panel={panel({ account_label: 'work' })} account="work" accountColor="#22c55e" />
  </Frame>
);

export const Mini = () => (
  <div style={{ width: 300, padding: '0.75rem', background: '#0f172a' }}>
    <LightboxProvider>
      <PanelCard
        panel={panel({
          status: 'mini',
          status_changed_at: NOW - 600,
          title: 'A long session title that should wrap onto a second line gracefully',
        })}
      />
    </LightboxProvider>
  </div>
);
