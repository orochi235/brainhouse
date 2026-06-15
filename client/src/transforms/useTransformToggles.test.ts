import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTogglesForTests,
  pruneToggles,
  readToggles,
  useTransformToggles,
} from './useTransformToggles.ts';

describe('useTransformToggles', () => {
  beforeEach(() => {
    __resetTogglesForTests();
  });
  afterEach(() => {
    __resetTogglesForTests();
  });

  it('unknown keys are enabled by default', () => {
    const { result } = renderHook(() => useTransformToggles('p1'));
    expect(result.current.isEnabled('anything')).toBe(true);
  });

  it('set(false) disables; isEnabled reflects it', () => {
    const { result } = renderHook(() => useTransformToggles('p1'));
    act(() => result.current.set('foo', false));
    expect(result.current.isEnabled('foo')).toBe(false);
    expect(result.current.all).toEqual({ foo: false });
  });

  it('persists across remount for the same panel', () => {
    const a = renderHook(() => useTransformToggles('p1'));
    act(() => a.result.current.set('foo', false));
    a.unmount();

    // Wipe in-memory cache so the next mount has to hydrate from
    // localStorage — proves persistence isn't just module-scoped memory.
    __resetMemoryOnly();

    const b = renderHook(() => useTransformToggles('p1'));
    expect(b.result.current.isEnabled('foo')).toBe(false);
  });

  it('disabling on panel A does not affect panel B', () => {
    const a = renderHook(() => useTransformToggles('A'));
    const b = renderHook(() => useTransformToggles('B'));
    act(() => a.result.current.set('foo', false));
    expect(a.result.current.isEnabled('foo')).toBe(false);
    expect(b.result.current.isEnabled('foo')).toBe(true);
  });

  it('prune drops in-memory entries for forgotten panels but keeps localStorage', () => {
    const a = renderHook(() => useTransformToggles('gone'));
    act(() => a.result.current.set('foo', false));
    a.unmount(); // no live subscribers left

    pruneToggles(new Set(['stillAlive']));

    // localStorage survives, so a fresh subscriber re-hydrates the value.
    const b = renderHook(() => useTransformToggles('gone'));
    expect(b.result.current.isEnabled('foo')).toBe(false);
  });

  it('prune leaves entries with live subscribers wired', () => {
    const a = renderHook(() => useTransformToggles('p1'));
    act(() => a.result.current.set('foo', false));
    // p1 is still mounted; prune must not orphan its subscription.
    pruneToggles(new Set());
    act(() => a.result.current.set('bar', false));
    expect(readToggles('p1')).toEqual({ foo: false, bar: false });
  });

  it('resetAll restores defaults and clears storage', () => {
    const { result } = renderHook(() => useTransformToggles('p1'));
    act(() => result.current.set('foo', false));
    act(() => result.current.set('bar', false));
    expect(result.current.all).toEqual({ foo: false, bar: false });
    act(() => result.current.resetAll());
    expect(result.current.all).toEqual({});
    expect(localStorage.getItem('bh.transforms.toggles.v1:p1')).toBeNull();
  });
});

// Drop only in-memory cache, leaving localStorage intact — so the
// "persists across remount" test can prove a fresh subscriber reads
// from disk, not from a sticky in-process map.
function __resetMemoryOnly(): void {
  // The module owns its own Map; the cleanest way to drop it without
  // exposing extra surface is to re-import. Vitest's module cache makes
  // that a no-op, so instead we round-trip via the documented reset
  // hook and re-populate localStorage from a captured snapshot.
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.startsWith('bh.transforms.toggles.v1:')) {
      const v = localStorage.getItem(k);
      if (v !== null) snapshot[k] = v;
    }
  }
  __resetTogglesForTests();
  for (const [k, v] of Object.entries(snapshot)) localStorage.setItem(k, v);
}
