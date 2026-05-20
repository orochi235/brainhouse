import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PanelState } from '../useDeltaStream.ts';
import { usePanelDismissal } from './hiddenPanels.ts';

function panel(id: string, overrides: Partial<PanelState> = {}): PanelState {
  return {
    id,
    kind: 'parent',
    parent_panel_id: null,
    title: id,
    agent_type: null,
    account_label: null,
    status: 'live',
    started_at: 0,
    last_event_at: Date.now() / 1000,
    status_changed_at: 0,
    event_count: 0,
    cwd: null,
    theme: null,
    binned_at: null,
    awaiting_input: false,
    events: [],
    ...overrides,
  } as PanelState;
}

function makePanels(...ps: PanelState[]): Map<string, PanelState> {
  return new Map(ps.map((p) => [p.id, p]));
}

describe('usePanelDismissal', () => {
  it('dismissing a live panel routes it to clientMini, not hiddenAt', () => {
    const live = panel('a');
    const { result } = renderHook(() => usePanelDismissal(makePanels(live)));
    act(() => result.current.dismiss(live));
    expect(result.current.isClientMini(live)).toBe(true);
    expect(result.current.isHidden(live)).toBe(false);
  });

  it('dismissing a server-mini panel fully hides it', () => {
    const mini = panel('a', { status: 'mini' });
    const { result } = renderHook(() => usePanelDismissal(makePanels(mini)));
    act(() => result.current.dismiss(mini));
    expect(result.current.isHidden(mini)).toBe(true);
    expect(result.current.isClientMini(mini)).toBe(false);
  });

  it('isHidden flips back to false once last_event_at advances past hideAt', () => {
    const mini = panel('a', { status: 'mini', last_event_at: 1_000 });
    const { result, rerender } = renderHook(({ p }) => usePanelDismissal(p), {
      initialProps: { p: makePanels(mini) },
    });
    act(() => result.current.dismiss(mini));
    expect(result.current.isHidden(mini)).toBe(true);
    const bumped = panel('a', { status: 'mini', last_event_at: Date.now() / 1000 + 60 });
    rerender({ p: makePanels(bumped) });
    expect(result.current.isHidden(bumped)).toBe(false);
  });

  it('restore clears both clientMini and hiddenAt for the id', () => {
    const live = panel('a');
    const { result } = renderHook(() => usePanelDismissal(makePanels(live)));
    act(() => result.current.dismiss(live));
    expect(result.current.isClientMini(live)).toBe(true);
    act(() => result.current.restore('a'));
    expect(result.current.isClientMini(live)).toBe(false);
    expect(result.current.isHidden(live)).toBe(false);
  });

  it('dismissAll sweeps every visible panel into hiddenAt at >= last_event_at', () => {
    const a = panel('a', { last_event_at: 100 });
    const b = panel('b', { last_event_at: 200 });
    const { result } = renderHook(() => usePanelDismissal(makePanels(a, b)));
    act(() => result.current.dismissAll());
    expect(result.current.isHidden(a)).toBe(true);
    expect(result.current.isHidden(b)).toBe(true);
    expect(result.current.isClientMini(a)).toBe(false);
    expect(result.current.isClientMini(b)).toBe(false);
  });

  it('stale first-sight panels (>30s since last event) auto-route to the dock', () => {
    const stale = panel('a', { last_event_at: Date.now() / 1000 - 600 });
    const { result } = renderHook(() => usePanelDismissal(makePanels(stale)));
    // Effect runs after first render; assert in next tick by reading result.
    expect(result.current.isClientMini(stale)).toBe(true);
  });

  it('fresh first-sight panels stay in the grid', () => {
    const fresh = panel('a', { last_event_at: Date.now() / 1000 });
    const { result } = renderHook(() => usePanelDismissal(makePanels(fresh)));
    expect(result.current.isClientMini(fresh)).toBe(false);
    expect(result.current.isHidden(fresh)).toBe(false);
  });

  it('prunes hiddenAt + clientMini entries when the server forgets a panel', () => {
    const a = panel('a');
    const { result, rerender } = renderHook(({ p }) => usePanelDismissal(p), {
      initialProps: { p: makePanels(a) },
    });
    act(() => result.current.dismiss(a));
    expect(result.current.isClientMini(a)).toBe(true);
    rerender({ p: makePanels() });
    // Panel gone from server → isClientMini for the ghost id is false.
    expect(result.current.isClientMini(a)).toBe(false);
  });
});
