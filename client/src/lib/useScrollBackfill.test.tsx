import type { Event } from '@server/parser.ts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollBackfill } from './useScrollBackfill.ts';

const queryMock = vi.fn();
vi.mock('../trpc.ts', () => ({
  trpc: { panelHistory: { query: (...a: unknown[]) => queryMock(...a) } },
}));

function ev(uuid: string): Event {
  return { kind: 'assistant_text', uuid, parent_uuid: null, ts: '2026-01-01T00:00:00Z' } as Event;
}
const bodyRef = { current: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 } } as never;

afterEach(() => queryMock.mockReset());

describe('useScrollBackfill', () => {
  it('prepends fetched older events to the live events', async () => {
    queryMock.mockResolvedValue({ events: [ev('old1'), ev('old2')], hasMore: true });
    const live = [ev('live1')];
    const { result } = renderHook(() =>
      useScrollBackfill({ bodyRef, panelId: 'S', liveEvents: live, hasMore: true }),
    );
    expect(result.current.mergedEvents.map((e) => e.uuid)).toEqual(['live1']);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.mergedEvents.map((e) => e.uuid)).toEqual(['old1', 'old2', 'live1']);
    expect(queryMock).toHaveBeenCalledWith({ panelId: 'S', beforeUuid: 'live1', limit: 500 });
  });

  it('does not issue a second fetch while one is in flight', async () => {
    let resolve!: (v: unknown) => void;
    queryMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() =>
      useScrollBackfill({ bodyRef, panelId: 'S', liveEvents: [ev('live1')], hasMore: true }),
    );
    act(() => {
      void result.current.loadOlder();
      void result.current.loadOlder();
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ events: [ev('old1')], hasMore: false });
    });
  });

  it('clears the backfill buffer when reset() is called (return-to-tail)', async () => {
    queryMock.mockResolvedValue({ events: [ev('old1')], hasMore: false });
    const { result } = renderHook(() =>
      useScrollBackfill({ bodyRef, panelId: 'S', liveEvents: [ev('live1')], hasMore: true }),
    );
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.mergedEvents).toHaveLength(2);
    act(() => result.current.reset());
    expect(result.current.mergedEvents.map((e) => e.uuid)).toEqual(['live1']);
  });
});
