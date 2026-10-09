/** Tiny localStorage-backed boolean prefs that drive body-class toggles. */

import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'transom';

const THEMES: readonly ThemePref[] = ['light', 'dark', 'transom'];

export const nextTheme = (t: ThemePref): ThemePref =>
  THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];

function readBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === '1') return true;
  if (v === '0') return false;
  return fallback;
}

export function useBoolPref(
  key: string,
  initial: boolean,
): readonly [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => readBool(key, initial));
  useEffect(() => {
    localStorage.setItem(key, value ? '1' : '0');
  }, [key, value]);
  return [value, setValue] as const;
}

export function useTheme(): readonly [ThemePref, (t: ThemePref) => void] {
  const [theme, setTheme] = useState<ThemePref>(() => {
    const saved = localStorage.getItem('brainhouse-theme');
    if (THEMES.includes(saved as ThemePref)) return saved as ThemePref;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('brainhouse-theme', theme);
  }, [theme]);
  return [theme, setTheme] as const;
}
