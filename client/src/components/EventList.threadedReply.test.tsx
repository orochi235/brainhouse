import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { ViewItemList } from './EventList.tsx';

const asstBubble = (replyTo: { kind: 'btw' | 'task'; quote: string; refUuid: string }) =>
  ({
    type: 'bubble',
    role: 'assistant',
    parts: [{ kind: 'text', text: 'the reply body' }],
    replyTo,
    event: {
      kind: 'assistant_text',
      payload: { text: 'the reply body' },
      uuid: 'a1',
      parent_uuid: null,
      session_id: 's',
      agent_id: null,
      ts: '2026-06-13T00:00:00Z',
      cwd: null,
      tags: [],
    },
  }) as unknown as ViewItem;

describe('threaded-reply render', () => {
  it('renders a quote button with the quote text and fires onReplyJump with refUuid', () => {
    const onReplyJump = vi.fn();
    render(
      <ViewItemList
        items={[asstBubble({ kind: 'btw', quote: 'also add oklch', refUuid: 'x1' })]}
        onReplyJump={onReplyJump}
      />,
    );
    const btn = screen.getByRole('button', { name: /also add oklch/ });
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(onReplyJump).toHaveBeenCalledWith('x1');
  });

  it('marks the bubble with kind-specific reply classes and sets data-anchor-uuid', () => {
    const { container } = render(
      <ViewItemList items={[asstBubble({ kind: 'task', quote: 'job done', refUuid: 'x2' })]} />,
    );
    expect(container.querySelector('.bubble.has-reply.is-task')).toBeTruthy();
    expect(container.querySelector('[data-anchor-uuid="a1"]')).toBeTruthy();
  });

  it('renders a notification-anchor with a data-anchor-uuid scroll target', () => {
    const { container } = render(
      <ViewItemList
        items={[
          {
            type: 'notification-anchor',
            anchorUuid: 'n1',
            summary: 'Background command "X" completed (exit code 0)',
            ts: '2026-06-13T00:00:00Z',
          } as ViewItem,
        ]}
      />,
    );
    expect(container.querySelector('[data-anchor-uuid="n1"]')).toBeTruthy();
    expect(screen.getByText(/Background command "X" completed/)).toBeInTheDocument();
  });
});
