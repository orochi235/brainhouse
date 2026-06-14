import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../trpc.ts', () => ({
  trpc: {
    eventByUuid: {
      query: vi.fn(async () => ({
        event: {
          kind: 'assistant_text',
          payload: { text: 'the backfilled original' },
          uuid: 'far-uuid', parent_uuid: null, session_id: 's', agent_id: null,
          ts: '2026-06-12T00:00:00Z', cwd: null, tags: [],
        },
      })),
    },
  },
}));

import { trpc } from '../trpc.ts';
import { LightboxProvider } from '../lib/lightbox.tsx';
import { ThreadedReplyLightbox } from './ThreadedReplyLightbox.tsx';

const panel = {
  id: 'p1', title: 'Test panel', cwd: null, theme: null, manually_renamed: false,
  events: [
    { kind: 'assistant_text', payload: { text: 'in-window event' }, uuid: 'near-uuid',
      parent_uuid: null, session_id: 's', agent_id: null, ts: '2026-06-13T00:00:00Z', cwd: null, tags: ['dialogue'] },
  ],
} as unknown as Parameters<typeof ThreadedReplyLightbox>[0]['panel'];

function renderInLightbox(ui: React.ReactElement) {
  return render(<LightboxProvider>{ui}</LightboxProvider>);
}

describe('ThreadedReplyLightbox', () => {
  it('backfills an out-of-window refUuid and renders it', async () => {
    renderInLightbox(<ThreadedReplyLightbox panel={panel} refUuid="far-uuid" />);
    await waitFor(() => expect(trpc.eventByUuid.query).toHaveBeenCalledWith({ panelId: 'p1', uuid: 'far-uuid' }));
    await waitFor(() => expect(screen.getByText(/the backfilled original/)).toBeInTheDocument());
  });

  it('does not backfill when refUuid is already in the window', async () => {
    vi.mocked(trpc.eventByUuid.query).mockClear();
    renderInLightbox(<ThreadedReplyLightbox panel={panel} refUuid="near-uuid" />);
    expect(screen.getByText(/in-window event/)).toBeInTheDocument();
    expect(trpc.eventByUuid.query).not.toHaveBeenCalled();
  });
});
