import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useHiddenWidgets } from './hiddenWidgets.ts';

describe('useHiddenWidgets', () => {
  it('hiding a widget marks it hidden and stays sticky', () => {
    const { result } = renderHook(() => useHiddenWidgets());
    expect(result.current.isHiddenWidget('project:foo')).toBe(false);
    act(() => result.current.hide('project:foo'));
    expect(result.current.isHiddenWidget('project:foo')).toBe(true);
  });

  it('hide is independent of any activity timestamp (no resurrection)', () => {
    // Unlike usePanelDismissal.isHidden, there is no last_event_at compare:
    // a hidden widget aggregating an active project must NOT reappear when
    // the project keeps emitting events. The hook holds no timestamps at all.
    const { result } = renderHook(() => useHiddenWidgets());
    act(() => result.current.hide('project:active'));
    expect(result.current.isHiddenWidget('project:active')).toBe(true);
    // No panels/timestamps are passed in, so nothing can flip it back.
    expect(result.current.isHiddenWidget('project:active')).toBe(true);
  });

  it('show clears the hidden flag', () => {
    const { result } = renderHook(() => useHiddenWidgets());
    act(() => result.current.hide('project:foo'));
    act(() => result.current.show('project:foo'));
    expect(result.current.isHiddenWidget('project:foo')).toBe(false);
  });

  it('seeds from initial set', () => {
    // `initial` must be a stable reference — like the memoized `seeded` set
    // App.tsx passes — or the re-seed effect (deps [initial]) re-fires every
    // render. The hooks in this codebase all rely on that invariant.
    const seeded = new Set(['project:seeded']);
    const { result } = renderHook(() => useHiddenWidgets({ initial: seeded }));
    expect(result.current.isHiddenWidget('project:seeded')).toBe(true);
  });

  it('re-seeds from late-arriving initial until the user touches state', () => {
    const { result, rerender } = renderHook(({ initial }) => useHiddenWidgets({ initial }), {
      initialProps: { initial: new Set<string>() },
    });
    expect(result.current.isHiddenWidget('project:late')).toBe(false);
    rerender({ initial: new Set(['project:late']) });
    expect(result.current.isHiddenWidget('project:late')).toBe(true);
  });

  it('does not clobber a user click with a late-arriving seed', () => {
    const { result, rerender } = renderHook(({ initial }) => useHiddenWidgets({ initial }), {
      initialProps: { initial: new Set<string>() },
    });
    act(() => result.current.hide('project:foo'));
    rerender({ initial: new Set(['project:other']) });
    // user's hide survives; the late seed is ignored once touched
    expect(result.current.isHiddenWidget('project:foo')).toBe(true);
    expect(result.current.isHiddenWidget('project:other')).toBe(false);
  });

  it('persists hide and show through the persist callback', () => {
    const persist = vi.fn();
    const { result } = renderHook(() => useHiddenWidgets({ persist }));
    act(() => result.current.hide('project:foo'));
    expect(persist).toHaveBeenCalledWith('project:foo', true);
    act(() => result.current.show('project:foo'));
    expect(persist).toHaveBeenCalledWith('project:foo', false);
  });
});
