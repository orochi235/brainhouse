import type { HighlightSpec } from '@server/search/search.ts';
import type { IndexStatus } from '@server/search/service.ts';
import classNames from 'classnames';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../../trpc.ts';
import { Reader } from './Reader.tsx';
import { activeHitId, ResultsList, type Selection } from './ResultsList.tsx';
import { rememberQuery } from './recent.ts';
import { EmptyState, NoResults } from './SearchEmpty.tsx';
import { useSearch } from './useSearch.ts';

const ROLE_CHIPS = ['you', 'ai', 'thinking', 'tool', 'out', 'error'] as const;
const STATUS_POLL_MS = 2000;

/** Add `token` to the query, or take it out if it is already there. */
export function toggleToken(q: string, token: string): string {
  const parts = q.split(/\s+/).filter(Boolean);
  const without = parts.filter((p) => p.toLowerCase() !== token.toLowerCase());
  return (without.length === parts.length ? [...parts, token] : without).join(' ');
}

export function SearchModal({ initialQuery }: { initialQuery: string }) {
  const [q, setQ] = useState(initialQuery);
  const search = useSearch(q);
  const [selected, setSelected] = useState<Selection | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const status = useIndexStatus();

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // A new answer starts the selection back at its first hit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new answer, not on every page loaded into it
  useEffect(() => {
    setSelected(search.groups.length ? { group: 0, hit: 0 } : null);
  }, [search.answered]);

  const highlightJson = JSON.stringify(search.result?.highlight ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the JSON so a new page of the same query keeps the reader's transcript
  const highlight = useMemo<HighlightSpec>(
    () => search.result?.highlight ?? { terms: [], regex: null },
    [highlightJson],
  );

  const group = selected ? search.groups[selected.group] : undefined;
  const hit = group && selected ? group.hits[selected.hit] : undefined;

  const move = (dir: 1 | -1, bySession: boolean) => {
    const groups = search.groups;
    if (groups.length === 0) return;
    const s = selected ?? { group: 0, hit: 0 };
    let next: Selection;
    if (bySession) {
      next = { group: clamp(s.group + dir, 0, groups.length - 1), hit: 0 };
    } else {
      const g = groups[s.group];
      if (dir === 1 && g && s.hit + 1 < g.hits.length) next = { group: s.group, hit: s.hit + 1 };
      else if (dir === -1 && s.hit > 0) next = { group: s.group, hit: s.hit - 1 };
      else if (dir === 1) next = s.group + 1 < groups.length ? { group: s.group + 1, hit: 0 } : s;
      else {
        const prev = groups[s.group - 1];
        next = prev ? { group: s.group - 1, hit: prev.hits.length - 1 } : s;
      }
    }
    setSelected(next);
    if (next.group >= groups.length - 2 && search.result?.nextCursor && !search.result.partial) {
      search.more();
    }
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'Enter' && hit) {
      e.preventDefault();
      rememberQuery(q);
      readerRef.current?.focus();
    }
  };

  const r = search.result;
  return (
    <div className="search-modal">
      <div className="search-bar">
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          role="combobox"
          aria-expanded={search.groups.length > 0}
          aria-controls="search-results"
          aria-activedescendant={selected ? activeHitId(search.groups, selected) : undefined}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onInputKey}
          placeholder='Search transcripts — "phrase", /regex/, project:, role:, tool:, after:7d'
          spellCheck={false}
          autoComplete="off"
          aria-label="Search transcripts"
        />
        <span className="search-chips">
          {ROLE_CHIPS.map((role) => {
            const token = `role:${role}`;
            const on = q.split(/\s+/).some((p) => p.toLowerCase() === token);
            return (
              <button
                key={role}
                type="button"
                className={classNames('search-chip', on && 'is-on')}
                aria-pressed={on}
                onClick={() => {
                  setQ(toggleToken(q, token));
                  inputRef.current?.focus();
                }}
              >
                {role}
              </button>
            );
          })}
        </span>
      </div>
      {r && r.errors.length > 0 && <div className="search-errors">{r.errors.join(' · ')}</div>}
      <div className="search-body">
        {!q.trim() ? (
          <EmptyState onPick={(x) => setQ(x)} />
        ) : search.groups.length === 0 ? (
          <NoResults
            loading={search.loading}
            q={q}
            tooBroad={r?.tooBroad ?? false}
            error={search.error}
          />
        ) : (
          <>
            <ResultsList
              groups={search.groups}
              selected={selected}
              onSelect={(s) => {
                setSelected(s);
                rememberQuery(q);
              }}
              onOpen={(s) => {
                setSelected(s);
                rememberQuery(q);
                readerRef.current?.focus();
              }}
              canLoadMore={!!r?.nextCursor}
              onMore={search.more}
            />
            {group && hit ? (
              <Reader
                ref={readerRef}
                group={group}
                focusDocId={hit.docId}
                highlight={highlight}
                onExit={() => inputRef.current?.focus()}
              />
            ) : (
              <div className="search-reader" />
            )}
          </>
        )}
      </div>
      <footer className="search-footer">
        <span className="search-footer-keys">
          ↑↓ hit · ⇧↑↓ session · ↵ reader · n/N match · esc
        </span>
        <span className="search-footer-counts">
          {r && q.trim() ? (
            <>
              {r.totalHits.toLocaleString()} {r.totalHits === 1 ? 'hit' : 'hits'} in{' '}
              {r.totalSessions.toLocaleString()} {r.totalSessions === 1 ? 'session' : 'sessions'}
              {r.partial && (
                <>
                  {' '}
                  · searched back to {new Date(r.partial.scannedBackTo * 1000).toLocaleDateString()}{' '}
                  <button type="button" className="search-keep-going" onClick={search.more}>
                    keep searching
                  </button>
                </>
              )}
            </>
          ) : null}
          {status?.building && (
            <span className="search-indexing">
              {' '}
              · indexing, {status.pending.toLocaleString()} files to go; results are incomplete
            </span>
          )}
        </span>
        <span className="search-footer-time">{r && q.trim() ? `${r.elapsedMs} ms` : ''}</span>
      </footer>
    </div>
  );
}

function useIndexStatus(): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      trpc.search.status
        .query()
        .then((s) => {
          if (!live) return;
          setStatus(s);
          if (s.building) timer = setTimeout(poll, STATUS_POLL_MS);
        })
        .catch(() => {
          if (live) timer = setTimeout(poll, STATUS_POLL_MS * 5);
        });
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
