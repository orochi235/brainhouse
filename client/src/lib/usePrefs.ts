/**
 * Tiny client-side prefs cache. Fetches once on mount via tRPC, holds the
 * result, exposes a `refetch()` so a successful Save in the editor can pull
 * the fresh value back into the rest of the app.
 *
 * We deliberately don't subscribe to prefs changes from the server — the
 * editor is the only writer right now, and it triggers a refetch on save.
 * If we add other writers later, switch this to a subscription.
 */

import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../trpc.ts';

export interface ClientPrefs {
  display: {
    imessage: boolean;
    showElapsed: boolean;
    conversation: boolean;
    idleOpacity: number;
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
  };
  timings: {
    idleSeconds: number;
    miniSeconds: number;
    removeAfterSeconds: number;
    tickIntervalMs: number;
  };
  roots: Array<{ path: string; label?: string; color?: string }>;
}

const DEFAULT_PREFS: ClientPrefs = {
  display: { imessage: false, showElapsed: false, conversation: false, idleOpacity: 0.5 },
  messages: {
    thinking: true,
    system: true,
    meta: true,
    tools: true,
    fileChanges: true,
    opStrips: true,
  },
  workspace: { minCols: 1, minRows: 1, maxTileSpan: 0, spawnSubagentsMinimized: false },
  timings: { idleSeconds: 60, miniSeconds: 300, removeAfterSeconds: 86400, tickIntervalMs: 5000 },
  roots: [],
};

export function usePrefs() {
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

  return { prefs, refetch };
}
