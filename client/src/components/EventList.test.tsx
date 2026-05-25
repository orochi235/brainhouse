import type { Event, Tag } from '@server/parser.ts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LightboxProvider } from '../lib/lightbox.tsx';
import { EventList } from './EventList.tsx';

let uid = 0;
function ev<K extends Event['kind']>(
  kind: K,
  payload: Extract<Event, { kind: K }>['payload'],
): Event {
  uid += 1;
  // Mirror parser tagging so transforms/components that read tags see
  // the same classification they would in production.
  const tags: Tag[] = [];
  if (kind === 'user_text') {
    const isMeta = (payload as { is_meta?: boolean }).is_meta === true;
    if (isMeta) tags.push('meta');
    else tags.push('dialogue');
  } else if (kind === 'assistant_text') tags.push('dialogue');
  else if (kind === 'thinking') tags.push('thinking');
  else if (kind === 'tool_use' || kind === 'tool_result') tags.push('tool');
  else if (kind === 'system') tags.push('system');
  else if (kind === 'resource_usage') tags.push('usage');
  else tags.push('meta');
  return {
    kind,
    payload,
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 's1',
    agent_id: null,
    ts: '2026-05-19T00:00:00Z',
    cwd: null,
    tags,
  } as Event;
}

const userText = (text: string) => ev('user_text', { text });
const asstText = (text: string) => ev('assistant_text', { text });
const toolUse = (id: string, name: string, input: unknown = {}) =>
  ev('tool_use', { tool_use_id: id, name, input });
const toolResult = (id: string, content: unknown = 'ok', is_error = false) =>
  ev('tool_result', { tool_use_id: id, content, is_error });

function renderInLightbox(events: Event[]) {
  return render(
    <LightboxProvider>
      <EventList events={events} />
    </LightboxProvider>,
  );
}

describe('<EventList>', () => {
  it('renders a user bubble with role class', () => {
    const { container } = renderInLightbox([userText('hello')]);
    expect(container.querySelector('.event-user_text')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders an assistant bubble with role class', () => {
    const { container } = renderInLightbox([asstText('hi back')]);
    expect(container.querySelector('.event-assistant_text')).toBeInTheDocument();
  });

  it('renders a tool capsule for a Bash tool_use+result pair', () => {
    const { container } = renderInLightbox([
      userText('run something'),
      toolUse('t1', 'Bash', { command: 'echo hi' }),
      toolResult('t1', 'hi'),
    ]);
    expect(container.querySelector('.tool-capsule')).toBeInTheDocument();
    expect(container.querySelector('.tool-capsule.ok')).toBeInTheDocument();
  });

  it('adds the canceled class to the assistant bubble when a turn was interrupted', () => {
    const { container } = renderInLightbox([
      userText('explain X'),
      asstText('sure, here we go…'),
      userText('[Request interrupted by user]'),
      userText('nevermind'),
    ]);
    const asst = container.querySelector('.event-assistant_text');
    expect(asst).toHaveClass('canceled');
  });

  it('renders an AskUserQuestion tool_use as an assistant bubble (not a capsule)', () => {
    const { container } = renderInLightbox([
      toolUse('q1', 'AskUserQuestion', {
        questions: [
          {
            question: 'Pick one?',
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      }),
    ]);
    expect(container.querySelector('.event-assistant_text')).toBeInTheDocument();
    expect(container.querySelector('.tool-capsule')).toBeNull();
    expect(screen.getByText('Pick one?')).toBeInTheDocument();
  });

  it('renders a thinking event as an agent thought bubble', () => {
    const { container } = renderInLightbox([ev('thinking', { text: 'pondering' })]);
    expect(container.querySelector('.thought-bubble-agent')).toBeInTheDocument();
    expect(screen.getByText('pondering')).toBeInTheDocument();
  });

  it('does NOT render an is_meta user_text as a thought bubble', () => {
    // Thought bubbles are exclusively for the agent's `thinking` events.
    // User-attributed thought bubbles were a category error — the user
    // never has "thoughts" the UI is privy to, only typed messages.
    const { container } = renderInLightbox([
      ev('user_text', { text: 'synthetic prelude', is_meta: true }),
    ]);
    expect(container.querySelector('.thought-bubble-user')).toBeNull();
    expect(container.querySelector('.thought-bubble')).toBeNull();
  });

  it('collapses a run of non-bubble items between chats into an op-strip', () => {
    const { container } = renderInLightbox([
      userText('do a few things'),
      toolUse('t1', 'Read', { file_path: '/a.txt' }),
      toolResult('t1'),
      toolUse('t2', 'Read', { file_path: '/b.txt' }),
      toolResult('t2'),
      toolUse('t3', 'Read', { file_path: '/c.txt' }),
      toolResult('t3'),
      asstText('done'),
    ]);
    expect(container.querySelector('.event-op-strip')).toBeInTheDocument();
  });
});
