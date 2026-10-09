/** Tiny localStorage-backed boolean prefs that drive body-class toggles. */

import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark';

/** The look, independent of light/dark: type, palette family, chrome. */
export type StylePref = 'default' | 'transom';

const STYLES: readonly StylePref[] = ['default', 'transom'];

export const nextStyle = (s: StylePref): StylePref =>
  STYLES[(STYLES.indexOf(s) + 1) % STYLES.length];

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
    if (saved === 'light' || saved === 'dark') return saved;
    // transom was briefly a third theme before it became a style.
    if (saved === 'transom') {
      localStorage.setItem('brainhouse-style', 'transom');
      return 'dark';
    }
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('brainhouse-theme', theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

export function useStyle(): readonly [StylePref, (s: StylePref) => void] {
  const [style, setStyle] = useState<StylePref>(() => {
    const saved = localStorage.getItem('brainhouse-style');
    return STYLES.includes(saved as StylePref) ? (saved as StylePref) : 'default';
  });
  useEffect(() => {
    document.documentElement.dataset.style = style;
    localStorage.setItem('brainhouse-style', style);
  }, [style]);
  return [style, setStyle] as const;
}
