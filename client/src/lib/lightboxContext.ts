import { createContext, type ReactNode, useContext } from 'react';

export interface LightboxTheme {
  background: string;
  foreground: string;
}

export interface LightboxState {
  open: (
    content: ReactNode,
    opts?: { variant?: 'rich' | 'text'; theme?: LightboxTheme | null },
  ) => void;
  close: () => void;
  /** Install a guard. While set, attempts to close via Esc, backdrop
   * click, or the ✕ button are routed through it: returning true allows
   * the close, false blocks it. Pass `null` to clear. Cleared
   * automatically on each `open()` so a guard from a prior modal never
   * leaks. */
  setCloseGuard: (guard: (() => boolean) | null) => void;
}

// Kept in its own module — separate from <LightboxProvider> — so the
// context object's identity survives hot updates of lightbox.tsx. When a
// module that calls createContext is re-executed by HMR, every consumer
// still bound to the previous module instance reads the *old* context,
// finds no provider, and crashes with "useLightbox must be inside
// LightboxProvider". Editing the provider component must not mint a new
// context.
export const LightboxContext = createContext<LightboxState | null>(null);

export function useLightbox(): LightboxState {
  const ctx = useContext(LightboxContext);
  if (!ctx) throw new Error('useLightbox must be inside LightboxProvider');
  return ctx;
}
