import type { SearchGroupView } from '@server/search/api.ts';
import type { HighlightSpec } from '@server/search/search.ts';
import type { Transcript, TranscriptDoc } from '@server/search/transcript.ts';
import classNames from 'classnames';
import { forwardRef, type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { trpc } from '../../trpc.ts';
import { Highlighted } from './Highlighted.tsx';
import { formatClock, roleLabel } from './labels.ts';

/** Transcripts opened recently, so arrowing back and forth between hits in a
 * few sessions doesn't refetch them. */
const CACHE_SIZE = 8;
const cache = new Map<string, Promise<Transcript | null>>();

function loadTranscript(fileId: number, highlight: HighlightSpec): Promise<Transcript | null> {
  const key = `${fileId}\u0000${JSON.stringify(highlight)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = trpc.search.transcript.query({ fileId, highlight }) as Promise<Transcript | null>;
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return p;
}

function docDomId(docId: number): string {
  return `search-doc-${docId}`;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; t: Transcript };

export const Reader = forwardRef<
  HTMLDivElement,
  { group: SearchGroupView; focusDocId: number; highlight: HighlightSpec; onExit: () => void }
>(function Reader({ group, focusDocId, highlight, onExit }, ref) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [current, setCurrent] = useState(focusDocId);

  useEffect(() => {
    let live = true;
    setLoad({ kind: 'loading' });
    loadTranscript(group.fileId, highlight)
      .then((t) => {
        if (!live) return;
        setLoad(
          t
            ? { kind: 'ready', t }
            : { kind: 'error', message: 'This transcript is no longer indexed.' },
        );
      })
      .catch((err: unknown) => {
        if (live)
          setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [group.fileId, highlight]);

  useEffect(() => setCurrent(focusDocId), [focusDocId]);

  const hitIds = useMemo(
    () =>
      load.kind === 'ready' ? load.t.docs.filter((d) => d.ranges.length > 0).map((d) => d.id) : [],
    [load],
  );

  useEffect(() => {
    if (load.kind !== 'ready') return;
    // A hit can sit deep inside a long tool output: aim at its first match,
    // not at the middle of the row.
    const el = document.getElementById(docDomId(current));
    (el?.querySelector('mark') ?? el)?.scrollIntoView({ block: 'center' });
  }, [load, current]);

  const step = (dir: 1 | -1) => {
    if (hitIds.length === 0) return;
    const at = hitIds.indexOf(current);
    const next = at === -1 ? 0 : (at + dir + hitIds.length) % hitIds.length;
    setCurrent(hitIds[next] as number);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      // Keep the dialog open: Esc leaves the reader first.
      e.preventDefault();
      e.stopPropagation();
      onExit();
    }
  };

  const position = hitIds.indexOf(current) + 1;
  return (
    <div
      ref={ref}
      className="search-reader"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region that takes n/N and Esc
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Transcript"
    >
      <div className="search-reader-bar">
        <span className="search-reader-path" title={group.cwd ?? undefined}>
          {group.cwd ?? group.sessionId}
        </span>
        {hitIds.length > 0 && (
          <span className="search-reader-pos">
            match {position || '–'} of {hitIds.length} · n / N
          </span>
        )}
      </div>
      {load.kind === 'loading' && <div className="search-reader-status">Loading…</div>}
      {load.kind === 'error' && <div className="search-reader-status">{load.message}</div>}
      {load.kind === 'ready' && (
        <ol className="search-reader-docs">
          {load.t.docs.map((d) => (
            <ReaderDoc key={d.id} doc={d} current={d.id === current} />
          ))}
        </ol>
      )}
    </div>
  );
});

function ReaderDoc({ doc: d, current }: { doc: TranscriptDoc; current: boolean }) {
  const [full, setFull] = useState<string | null>(null);
  const tool = d.kind === 'tool_use' || d.kind === 'tool_result';
  return (
    <li
      id={docDomId(d.id)}
      className={classNames(
        'search-doc',
        `role-${d.kind}`,
        d.isError && 'is-error',
        d.ranges.length > 0 && 'has-match',
        current && 'is-current',
      )}
    >
      <div className="search-doc-head">
        <span className={classNames('search-role', `role-${d.kind}`, d.isError && 'is-error')}>
          {roleLabel(d.kind, d.tool, d.isError)}
        </span>
        <span className="search-doc-time">{formatClock(d.ts)}</span>
      </div>
      <div className={classNames('search-doc-text', tool && 'is-mono')}>
        {full ?? <Highlighted text={d.text} ranges={d.ranges} />}
        {d.truncated > 0 && full === null && (
          <button
            type="button"
            className="search-doc-expand"
            onClick={() =>
              void trpc.search.docText.query({ docId: d.id }).then((t) => setFull(t ?? d.text))
            }
          >
            … {d.truncated.toLocaleString()} more characters
          </button>
        )}
      </div>
    </li>
  );
}
