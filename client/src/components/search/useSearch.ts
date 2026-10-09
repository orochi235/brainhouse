import type { SearchGroupView, SearchResultView } from '@server/search/api.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../../trpc.ts';

const DEBOUNCE_MS = 150;

export interface SearchState {
  /** The query the shown results answer, which lags the input while typing. */
  answered: string;
  result: SearchResultView | null;
  /** Groups from every page loaded so far. */
  groups: SearchGroupView[];
  loading: boolean;
  error: string | null;
}

const EMPTY: SearchState = { answered: '', result: null, groups: [], loading: false, error: null };

/** Runs `q` against the server 150 ms after it stops changing. A reply to a
 * query the user has typed past is dropped. `more()` loads the next page, or
 * continues a scan that ran out of time. */
export function useSearch(q: string): SearchState & { more: () => void } {
  const [state, setState] = useState<SearchState>(EMPTY);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!q.trim()) {
      setState(EMPTY);
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      trpc.search.query
        .query({ q })
        .then((result) => {
          if (seq.current !== mine) return;
          setState({ answered: q, result, groups: result.groups, loading: false, error: null });
        })
        .catch((err: unknown) => {
          if (seq.current !== mine) return;
          setState((s) => ({
            ...s,
            loading: false,
            error: String(err instanceof Error ? err.message : err),
          }));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const more = useCallback(() => {
    const cursor = state.result?.nextCursor;
    if (!cursor || state.loading) return;
    const mine = seq.current;
    const answered = state.answered;
    setState((s) => ({ ...s, loading: true }));
    trpc.search.query
      .query({ q: answered, cursor })
      .then((result) => {
        if (seq.current !== mine) return;
        setState((s) => ({
          ...s,
          result,
          groups: mergeGroups(s.groups, result.groups),
          loading: false,
        }));
      })
      .catch((err: unknown) => {
        if (seq.current !== mine) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: String(err instanceof Error ? err.message : err),
        }));
      });
  }, [state.result, state.loading, state.answered]);

  return { ...state, more };
}

/** A resumed scan can find more hits in a session already shown; fold them
 * in rather than listing the session twice. */
function mergeGroups(prev: SearchGroupView[], next: SearchGroupView[]): SearchGroupView[] {
  const byId = new Map(prev.map((g) => [g.fileId, g]));
  const out = [...prev];
  for (const g of next) {
    const had = byId.get(g.fileId);
    if (!had) {
      out.push(g);
      continue;
    }
    const merged = { ...had, hitCount: had.hitCount + g.hitCount, hits: [...g.hits, ...had.hits] };
    out[out.indexOf(had)] = merged;
  }
  return out;
}
