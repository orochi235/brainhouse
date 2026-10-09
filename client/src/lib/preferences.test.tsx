import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { nextStyle, useBoolPref, useStyle, useTheme } from './preferences.ts';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.style;
});

describe('useBoolPref', () => {
  it('returns the fallback when nothing is stored', () => {
    const { result } = renderHook(() => useBoolPref('k', true));
    expect(result.current[0]).toBe(true);
  });

  it('reads "1" / "0" from localStorage on mount', () => {
    localStorage.setItem('k', '0');
    const { result } = renderHook(() => useBoolPref('k', true));
    expect(result.current[0]).toBe(false);
  });

  it('writes back to localStorage when the setter is called', () => {
    const { result } = renderHook(() => useBoolPref('k', false));
    act(() => result.current[1](true));
    expect(localStorage.getItem('k')).toBe('1');
  });

  it('ignores garbage in localStorage and falls back', () => {
    localStorage.setItem('k', 'maybe');
    const { result } = renderHook(() => useBoolPref('k', true));
    expect(result.current[0]).toBe(true);
  });
});

describe('useTheme', () => {
  it('honors a stored theme', () => {
    localStorage.setItem('brainhouse-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('light');
  });

  it('sets data-theme on documentElement', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => result.current[1]('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists the theme to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]('light'));
    expect(localStorage.getItem('brainhouse-theme')).toBe('light');
  });
});

describe('useStyle', () => {
  it('defaults to the default style', () => {
    const { result } = renderHook(() => useStyle());
    expect(result.current[0]).toBe('default');
  });

  it('sets data-style on documentElement and persists it', () => {
    const { result } = renderHook(() => useStyle());
    act(() => result.current[1]('transom'));
    expect(document.documentElement.dataset.style).toBe('transom');
    expect(localStorage.getItem('brainhouse-style')).toBe('transom');
  });

  it('carries a stored transom theme over as dark plus the transom style', () => {
    localStorage.setItem('brainhouse-theme', 'transom');
    expect(renderHook(() => useTheme()).result.current[0]).toBe('dark');
    expect(renderHook(() => useStyle()).result.current[0]).toBe('transom');
  });
});

describe('nextStyle', () => {
  it('cycles through the styles', () => {
    expect(nextStyle('default')).toBe('transom');
    expect(nextStyle('transom')).toBe('default');
  });
});
