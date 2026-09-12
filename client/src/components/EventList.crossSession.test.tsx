import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { ViewItemList } from './EventList.tsx';

const event = (uuid: string, kind: string, text: string) => ({
  kind,
  payload: { text },
  uuid,
  parent_uuid: null,
  session_id: 's',
  agent_id: null,
  ts: '2026-08-24T03:36:56Z',
  cwd: null,
  tags: [],
});

const peerBubble = (from: string, text: string) =>
  ({
    type: 'bubble',
    role: 'user',
    from,
    parts: [{ kind: 'text', text }],
    event: event('p1', 'user_text', text),
  }) as unknown as ViewItem;

const answeringBubble = () =>
  ({
    type: 'bubble',
    role: 'assistant',
    parts: [{ kind: 'text', text: 'holding the merge' }],
    replyTo: { kind: 'agent', from: 'portfolio-14', quote: 'main is not free', refUuid: 'p1' },
    event: event('a1', 'assistant_text', 'holding the merge'),
  }) as unknown as ViewItem;

describe('cross-session message render', () => {
  it('attributes an incoming peer bubble to the sending session', () => {
    const { container } = render(
      <ViewItemList items={[peerBubble('portfolio-14', 'main is not free')]} />,
    );
    expect(screen.getByText('portfolio-14')).toBeInTheDocument();
    expect(container.querySelector('.bubble.from-peer')).toBeTruthy();
  });

  it('names the peer in the quote above the answering bubble', () => {
    const { container } = render(
      <ViewItemList items={[answeringBubble()]} onReplyJump={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /portfolio-14/ })).toBeInTheDocument();
    expect(container.querySelector('.bubble.has-reply.is-agent')).toBeTruthy();
  });
});
