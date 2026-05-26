/**
 * Client-side prefs cache. A single `PrefsProvider` at the app root
 * fetches once via tRPC and shares the result through context.
 * `usePrefs()` reads from that context — so every panel sees the
 * same value, and a refetch (triggered by the editor on Save) updates
 * everyone at once.
 *
 * Previously each `usePrefs()` call mounted its own state and fired
 * its own fetch. With N panels that meant N independent races against
 * a single render — panels that hadn't completed their fetch yet
 * (or whose fetch failed) silently used DEFAULT_PREFS, which is why
 * the `prefs.debug.enabled` flag would intermittently disappear from
 * a panel's tool palette.
 *
 * We deliberately don't subscribe to prefs changes from the server —
 * the editor is the only writer right now, and it triggers a refetch
 * on save. If we add other writers later, switch this to a
 * subscription.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { trpc } from '../trpc.ts';

export interface ClientPrefs {
  display: {
    imessage: boolean;
    showElapsed: boolean;
    conversation: boolean;
    idleOpacity: number;
    huedHeaderStrength: number;
    toolPaletteDisplay: 'hover' | 'always';
    showSessionTime: boolean;
    showTokens: boolean;
    showContext: boolean;
    autoTitle: boolean;
  };
  messages: {
    thinking: boolean;
    system: boolean;
    meta: boolean;
    tools: boolean;
    fileChanges: boolean;
    opStrips: boolean;
  };
  workspace: {
    minCols: number;
    minRows: number;
    maxTileSpan: number;
    spawnSubagentsMinimized: boolean;
    autoMinimizeOnClear: boolean;
    groupByWorktree: boolean;
    slotCount: number;
  };
  timings: {
    idleSeconds: number;
    miniSeconds: number;
    removeAfterSeconds: number;
    tickIntervalMs: number;
  };
  roots: Array<{ path: string; label?: string; color?: string }>;
  storage: {
    persistEnabled: boolean;
    eventsIndexRetentionDays: number;
  };
  editor: {
    urlTemplate: string;
  };
  notifications: {
    tabTitleFlash: boolean;
    browserNotification: boolean;
    audibleChime: boolean;
  };
  debug: {
    enabled: boolean;
  };
}

const DEFAULT_PREFS: ClientPrefs = {
  display: {
    imessage: false,
    showElapsed: false,
    conversation: false,
    idleOpacity: 0.5,
    huedHeaderStrength: 0.14,
    toolPaletteDisplay: 'hover',
    showSessionTime: true,
    showTokens: true,
    showContext: true,
    autoTitle: true,
  },
  messages: {
    thinking: true,
    system: true,
    meta: true,
    tools: true,
    fileChanges: true,
    opStrips: true,
  },
  workspace: {
    minCols: 1,
    minRows: 1,
    maxTileSpan: 0,
    spawnSubagentsMinimized: false,
    autoMinimizeOnClear: true,
    groupByWorktree: false,
    slotCount: 4,
  },
  timings: { idleSeconds: 60, miniSeconds: 300, removeAfterSeconds: 86400, tickIntervalMs: 5000 },
  roots: [],
  storage: { persistEnabled: false, eventsIndexRetentionDays: 30 },
  editor: { urlTemplate: 'cursor://file/{path}:{line}' },
  notifications: {
    tabTitleFlash: true,
    browserNotification: false,
    audibleChime: false,
  },
  debug: { enabled: false },
};

interface PrefsContextValue {
  prefs: ClientPrefs;
  refetch: () => Promise<void>;
}

const Ctx = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ClientPrefs>(DEFAULT_PREFS);

  const refetch = useCallback(async () => {
    try {
      const p = await trpc.prefs.get.query();
      setPrefs(p as ClientPrefs);
    } catch {
      // Server may be unreachable — keep last known prefs.
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const value = useMemo<PrefsContextValue>(() => ({ prefs, refetch }), [prefs, refetch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(Ctx);
  // Defensive fallback: if a component renders outside the provider
  // (e.g. a Storybook story, a test, or a misplaced consumer), serve
  // defaults rather than crashing. This matches the prior per-hook
  // behavior on first render so callers don't need null checks.
  if (!ctx) return { prefs: DEFAULT_PREFS, refetch: async () => undefined };
  return ctx;
}
