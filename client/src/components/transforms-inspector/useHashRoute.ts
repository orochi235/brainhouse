/**
 * Two-way binding for the inspector's URL hash so deep-links + cross-tab
 * navigation are just hash mutations. Hash format:
 *
 *   #inspector/<tab>/<key>
 *
 * `tab` ∈ { 'types', 'transforms', 'trace' }. `key` is optional.
 *
 * Outside the inspector context (no `#inspector/` prefix), this hook is
 * a no-op reader — it returns `null` for both fields and `setRoute()`
 * still writes the hash.
 */

import { useCallback, useEffect, useState } from 'react';

export type InspectorTab = 'types' | 'transforms' | 'trace';

export interface InspectorRoute {
  tab: InspectorTab | null;
  key: string | null;
}

function parseHash(hash: string): InspectorRoute {
  const m = hash.match(/^#inspector\/(types|transforms|trace)(?:\/(.+))?$/);
  if (!m) return { tab: null, key: null };
  return { tab: m[1] as InspectorTab, key: m[2] ? decodeURIComponent(m[2]) : null };
}

function serialize(route: InspectorRoute): string {
  if (!route.tab) return '';
  const base = `#inspector/${route.tab}`;
  return route.key ? `${base}/${encodeURIComponent(route.key)}` : base;
}

export function useHashRoute(initial: InspectorTab = 'types'): {
  route: InspectorRoute;
  setRoute: (next: InspectorRoute) => void;
} {
  const [route, setRouteState] = useState<InspectorRoute>(() => {
    const parsed = parseHash(window.location.hash);
    if (parsed.tab) return parsed;
    return { tab: initial, key: null };
  });

  useEffect(() => {
    const onHash = () => setRouteState(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setRoute = useCallback((next: InspectorRoute) => {
    const target = serialize(next);
    if (target !== window.location.hash) {
      window.history.replaceState(null, '', target || window.location.pathname);
    }
    setRouteState(next);
  }, []);

  return { route, setRoute };
}
