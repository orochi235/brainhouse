import type { SearchGroupView } from '@server/search/api.ts';
import classNames from 'classnames';
import { type CSSProperties, useEffect, useRef } from 'react';
import { projectLabel } from '../../lib/project.ts';
import { isPlaceholderTitle } from '../../lib/sessionTitle.ts';
import { Highlighted } from './Highlighted.tsx';
import { formatWhen, roleLabel } from './labels.ts';

export interface Selection {
  group: number;
  hit: number;
}

export function hitDomId(fileId: number, docId: number): string {
  return `search-hit-${fileId}-${docId}`;
}

export function ResultsList({
  groups,
  selected,
  onSelect,
  onOpen,
  canLoadMore,
  onMore,
}: {
  groups: SearchGroupView[];
  selected: Selection | null;
  onSelect: (s: Selection) => void;
  onOpen: (s: Selection) => void;
  canLoadMore: boolean;
  onMore: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeId = selected ? activeHitId(groups, selected) : undefined;

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  return (
    <div
      ref={listRef}
      className="search-results"
      id="search-results"
      role="listbox"
      aria-label="Search results"
    >
      {groups.map((g, gi) => (
        <section
          key={g.fileId}
          className={classNames('search-group', g.theme && 'has-theme')}
          style={
            g.theme ? ({ '--panel-theme-bg': g.theme.background } as CSSProperties) : undefined
          }
        >
          <GroupHeader group={g} />
          {g.hits.map((h, hi) => {
            const isSel = selected?.group === gi && selected.hit === hi;
            return (
              <div
                key={h.docId}
                id={hitDomId(g.fileId, h.docId)}
                role="option"
                tabIndex={-1}
                aria-selected={isSel}
                className={classNames('search-hit', isSel && 'is-selected')}
                onClick={() => onSelect({ group: gi, hit: hi })}
                onDoubleClick={() => onOpen({ group: gi, hit: hi })}
              >
                <span
                  className={classNames('search-role', `role-${h.kind}`, h.isError && 'is-error')}
                >
                  {roleLabel(h.kind, h.tool, h.isError)}
                </span>
                <HitSnippet hit={h} />
              </div>
            );
          })}
          {g.hitCount > g.hits.length && (
            <div className="search-group-more">
              +{g.hitCount - g.hits.length} more in this session; n steps through them in the reader
            </div>
          )}
        </section>
      ))}
      {canLoadMore && (
        <button type="button" className="search-load-more" onClick={onMore}>
          Load more sessions
        </button>
      )}
    </div>
  );
}

/** A list row is narrow, so start it a few characters before the first
 * match instead of the server's wider lead-in. */
const ROW_LEAD = 24;

function HitSnippet({ hit: h }: { hit: SearchGroupView['hits'][number] }) {
  const first = h.ranges[0]?.[0] ?? 0;
  const cut = Math.max(0, first - ROW_LEAD);
  return (
    <span className="search-snippet">
      {(h.clippedStart || cut > 0) && '…'}
      <Highlighted
        text={h.snippet.slice(cut)}
        ranges={h.ranges.map(([a, b]) => [a - cut, b - cut] as [number, number])}
      />
    </span>
  );
}

function GroupHeader({ group: g }: { group: SearchGroupView }) {
  const project = projectLabel(g.cwd, g.repoRoot) || 'unknown project';
  const id = g.agentId ?? g.sessionId;
  const title = g.title && !isPlaceholderTitle(g.title, id) ? g.title : null;
  return (
    <header className="search-group-header">
      {g.live && <span className="search-live-dot" title="Live session" />}
      <span className="search-project">{project}</span>
      {g.agentId && <span className="search-subagent">{g.agentType ?? 'subagent'}</span>}
      <span className="search-title">
        {title ?? <span className="search-untitled">{id.slice(0, 8)}</span>}
      </span>
      <span className="search-group-meta">
        {g.account && <span className="search-account">{g.account}</span>}
        <span className="search-count">{g.hitCount}</span>
        <span className="search-when">{formatWhen(g.latestHitTs)}</span>
      </span>
    </header>
  );
}

export function activeHitId(groups: SearchGroupView[], s: Selection): string | undefined {
  const g = groups[s.group];
  const h = g?.hits[s.hit];
  return g && h ? hitDomId(g.fileId, h.docId) : undefined;
}
