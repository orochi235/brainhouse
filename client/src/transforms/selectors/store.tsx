/**
 * Union of built-in + user-authored selectors, exposed via React context.
 * User entries are namespaced (`user.` prefix) — collisions with built-ins
 * are rejected. v1 is in-memory only; refresh wipes user entries.
 */

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { SELECTORS, type SelectorDef } from './index.ts';

export type SelectorOrigin = 'builtin' | 'user';
export type StoredSelectorDef = SelectorDef & { origin: SelectorOrigin };

export interface SelectorStore {
  all: StoredSelectorDef[];
  byKey: Map<string, StoredSelectorDef>;
  addUser(def: SelectorDef): void;
  removeUser(key: string): void;
}

const Ctx = createContext<SelectorStore | null>(null);

const BUILTINS: StoredSelectorDef[] = SELECTORS.map((s) => ({ ...s, origin: 'builtin' }));
const BUILTIN_KEYS = new Set(BUILTINS.map((s) => s.key));

export function SelectorStoreProvider({ children }: { children: ReactNode }) {
  const [userEntries, setUserEntries] = useState<StoredSelectorDef[]>([]);

  const addUser = useCallback((def: SelectorDef) => {
    if (!def.key.startsWith('user.')) {
      throw new Error(`user-authored selector keys must start with "user." (got "${def.key}")`);
    }
    if (BUILTIN_KEYS.has(def.key)) {
      throw new Error(`key "${def.key}" collides with a built-in selector`);
    }
    let collided = false;
    setUserEntries((prev) => {
      if (prev.some((p) => p.key === def.key)) {
        collided = true;
        return prev;
      }
      return [...prev, { ...def, origin: 'user' }];
    });
    if (collided) {
      throw new Error(`user selector "${def.key}" already exists`);
    }
  }, []);

  const removeUser = useCallback((key: string) => {
    setUserEntries((prev) => prev.filter((p) => p.key !== key));
  }, []);

  const store = useMemo<SelectorStore>(() => {
    const all = [...BUILTINS, ...userEntries];
    const byKey = new Map(all.map((s) => [s.key, s]));
    return { all, byKey, addUser, removeUser };
  }, [userEntries, addUser, removeUser]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useSelectors(): SelectorStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSelectors must be inside <SelectorStoreProvider>');
  return ctx;
}
