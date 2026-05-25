/**
 * Debug tile that polls the server's `debugState` query and renders
 * model state independent of any client rendering filters. Always
 * present when the URL carries `?debug=1`. Slots into the workspace
 * grid as a normal `.grid-slot`.
 *
 * Purpose: when the rendered UI disagrees with the server's model
 * (phantom subagent rows, stale tabs, panels that "should exist"
 * but don't), this tile shows the model directly so the gap is
 * obvious.
 */

import { useEffect, useState } from 'react';
import { deriveWorktree, worktreeColor } from '../lib/worktree.ts';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';

type DebugState = Awaited<ReturnType<typeof trpc.debugState.query>>;

const POLL_MS = 2000;

type SortKey =
  | 'id'
  | 'kind'
  | 'state'
  | 'slot'
  | 'age'
  | 'project'
  | 'worktree'
  | 'title'
  | 'server';

function projectKey(cwd: string | null): string {
  if (!cwd) return '';
  const segs = cwd.replace(/\/+$/, '').split('/');
  return (segs[segs.length - 1] ?? '').toLowerCase();
}

function worktreeLabel(cwd: string | null): string {
  const wt = deriveWorktree(cwd);
  return wt ? wt.name : '';
}

function makeComparator(
  key: SortKey,
  dir: 'asc' | 'desc',
  slotById: Map<string, string>,
  serverPanels: Set<string> | null,
): (a: PanelState, b: PanelState) => number {
  const mul = dir === 'asc' ? 1 : -1;
  const slotOrder: Record<string, number> = { orphan: 0, grid: 1, dock: 2, nested: 3 };
  const stateOrder: Record<string, number> = { live: 0, done: 1, mini: 2 };
  return (a, b) => {
    let v: number;
    switch (key) {
      case 'id':
        v = a.id.localeCompare(b.id);
        break;
      case 'kind':
        v = a.kind.localeCompare(b.kind);
        break;
      case 'state': {
        const sa = stateOrder[a.status] ?? 99;
        const sb = stateOrder[b.status] ?? 99;
        v = sa - sb;
        break;
      }
      case 'slot': {
        const za = slotOrder[slotById.get(a.id) ?? 'nested'] ?? 99;
        const zb = slotOrder[slotById.get(b.id) ?? 'nested'] ?? 99;
        v = za - zb;
        break;
      }
      case 'age':
        v = a.last_event_at - b.last_event_at;
        break;
      case 'project':
        v = projectKey(a.cwd).localeCompare(projectKey(b.cwd));
        break;
      case 'worktree':
        v = worktreeLabel(a.cwd).localeCompare(worktreeLabel(b.cwd));
        break;
      case 'title':
        v = a.title.localeCompare(b.title);
        break;
      case 'server': {
        if (!serverPanels) {
          v = 0;
        } else {
          const av = serverPanels.has(a.id) ? 1 : 0;
          const bv = serverPanels.has(b.id) ? 1 : 0;
          v = av - bv;
        }
        break;
      }
    }
    return v * mul;
  };
}

export interface DebugTileClientView {
  /** Every panel the client has heard of from the delta stream. */
  allPanels: Map<string, PanelState>;
  /** Ids currently rendered in the workspace grid (in order). */
  gridIds: string[];
  /** Ids currently rendered in the dock / tray (in order). */
  dockIds: string[];
  /** Predicates the client uses to route each panel. */
  isHidden: (p: PanelState) => boolean;
  isClientMini: (p: PanelState) => boolean;
  isPinned: (id: string) => boolean;
  isBrokenOut: (id: string) => boolean;
}

export function DebugTile({ client }: { client: DebugTileClientView }) {
  const [state, setState] = useState<DebugState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showServer, setShowServer] = useState(false);

  useEffect(() => {
    if (!showServer) return;
    let cancelled = false;
    trpc.debugState
      .query()
      .then((s) => {
        if (!cancelled) {
          setState(s);
          setErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick, showServer]);

  useEffect(() => {
    if (!showServer) return;
    const h = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(h);
  }, [showServer]);

  return (
    <article className="panel debug-tile" data-debug>
      <header className="panel-header">
        <span className="panel-title">debug · {showServer ? 'client + server' : 'client only'}</span>
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={showServer}
            onChange={(e) => setShowServer(e.target.checked)}
          />
          server state
        </label>
        <span className="debug-tile-meta">{client.allPanels.size} client panels</span>
      </header>
      <div className="panel-body debug-tile-body">
        <ClientContents client={client} serverState={showServer ? state : null} />
        {showServer && (
          <>
            {err && <div className="debug-error">{err}</div>}
            {state && <ServerContents state={state} client={client} />}
          </>
        )}
      </div>
    </article>
  );
}

function ClientContents({
  client,
  serverState,
}: {
  client: DebugTileClientView;
  serverState: DebugState | null;
}) {
  const { allPanels, gridIds, dockIds, isHidden, isClientMini, isPinned, isBrokenOut } = client;
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const gridSet = new Set(gridIds);
  const dockSet = new Set(dockIds);
  // Panels that exist in client model but aren't rendered anywhere.
  const orphans: PanelState[] = [];
  // Panels rendered as nested subagents (under another panel).
  const nestedSubs: PanelState[] = [];
  for (const p of allPanels.values()) {
    if (gridSet.has(p.id) || dockSet.has(p.id)) continue;
    if (p.kind === 'subagent' && p.parent_panel_id && allPanels.has(p.parent_panel_id)) {
      nestedSubs.push(p);
    } else {
      orphans.push(p);
    }
  }
  const serverPanels = serverState ? new Set(serverState.panels.map((p) => p.id)) : null;

  const now = Date.now() / 1000;

  // Figure out which slot each panel is rendered in. Used as a per-row chip
  // now that the table is grouped by parent rather than by slot.
  const slotById = new Map<string, string>();
  for (const id of gridIds) slotById.set(id, 'grid');
  for (const id of dockIds) slotById.set(id, 'dock');
  for (const p of nestedSubs) slotById.set(p.id, 'nested');
  for (const p of orphans) slotById.set(p.id, 'orphan');

  // Build a parent → children tree. Anything whose declared parent isn't
  // in the client map gets promoted to a root (so we don't drop subagents
  // whose parent panel was already removed).
  const childrenByParent = new Map<string, PanelState[]>();
  const roots: PanelState[] = [];
  for (const p of allPanels.values()) {
    const parentId = p.parent_panel_id;
    if (parentId && allPanels.has(parentId)) {
      let arr = childrenByParent.get(parentId);
      if (!arr) {
        arr = [];
        childrenByParent.set(parentId, arr);
      }
      arr.push(p);
    } else {
      roots.push(p);
    }
  }
  if (sort) {
    const cmp = makeComparator(sort.key, sort.dir, slotById, serverPanels);
    roots.sort(cmp);
    for (const arr of childrenByParent.values()) arr.sort(cmp);
  } else {
    const slotOrder: Record<string, number> = { orphan: 0, grid: 1, dock: 2, nested: 3 };
    roots.sort((a, b) => {
      const sa = slotOrder[slotById.get(a.id) ?? 'nested'] ?? 99;
      const sb = slotOrder[slotById.get(b.id) ?? 'nested'] ?? 99;
      if (sa !== sb) return sa - sb;
      return b.last_event_at - a.last_event_at;
    });
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => b.last_event_at - a.last_event_at);
    }
  }

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: key === 'age' ? 'desc' : 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };
  const sortGlyph = (key: SortKey): string =>
    sort?.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';

  const renderRow = (p: PanelState, depth: number) => {
    const slot = slotById.get(p.id) ?? 'nested';
    const onServer = serverPanels === null ? null : serverPanels.has(p.id);
    const proj = projectLabel(p.cwd);
    const colors = projectColors(p.theme);
    const rowStyle = colors
      ? ({
          ['--row-theme-bg' as string]: colors.background,
          ['--row-theme-fg' as string]: colors.foreground,
        } as React.CSSProperties)
      : undefined;
    return (
      <tr
        key={p.id}
        className={`debug-row${colors ? ' has-theme' : ''}${slot === 'orphan' ? ' debug-row-orphan' : ''}`}
        style={rowStyle}
      >
        <td className="debug-cell-title" title={p.title}>
          <span className="debug-tree-indent" style={{ paddingLeft: `${depth * 14}px` }}>
            {depth > 0 && <span className="debug-tree-branch">└</span>}
            <span
              className={`debug-kind-icon debug-kind-${p.kind}`}
              title={p.kind}
              aria-label={p.kind}
            >
              {p.kind === 'parent' ? '◆' : '○'}
            </span>
            {p.title}
          </span>
        </td>
        <td>
          <span className={`debug-state-chip debug-state-${p.status}`}>{p.status}</span>
          {isPinned(p.id) && (
            <span className="debug-flag" title="pinned">
              📌
            </span>
          )}
          {isBrokenOut(p.id) && (
            <span className="debug-flag" title="broken out">
              ⏏
            </span>
          )}
          {isHidden(p) && (
            <span className="debug-flag" title="hidden (server-mini after dismissAt)">
              🙈
            </span>
          )}
          {isClientMini(p) && (
            <span className="debug-flag" title="client-mini (dismissed to dock)">
              ▼
            </span>
          )}
          {p.awaiting_input && (
            <span className="debug-flag" title="awaiting input">
              ⏳
            </span>
          )}
          {p.ended && (
            <span className="debug-flag" title="ended">
              ✓
            </span>
          )}
        </td>
        <td>
          <span className={`debug-slot-chip debug-slot-${slot}`}>{slot}</span>
        </td>
        <td>{fmtAge(p.last_event_at, now)}</td>
        <td className="debug-cell-truncate" title={p.cwd ?? ''}>
          {proj}
        </td>
        <td>
          <WorktreeBadge cwd={p.cwd} />
        </td>
        {onServer !== null && (
          <td className={onServer ? '' : 'debug-gap-pos'}>{onServer ? '✓' : 'missing'}</td>
        )}
        <td className="debug-id-cell">
          <CopyableId id={p.id} />
        </td>
      </tr>
    );
  };

  const renderSubtree = (p: PanelState, depth: number): React.ReactNode[] => {
    const row = renderRow(p, depth);
    const kids = childrenByParent.get(p.id) ?? [];
    return [row, ...kids.flatMap((k) => renderSubtree(k, depth + 1))];
  };

  return (
    <div className="debug-stack">
      <Section title="Client routing summary">
        <table className="debug-table">
          <tbody>
            <tr>
              <td>panels known to client</td>
              <td>{allPanels.size}</td>
            </tr>
            <tr>
              <td>rendered in grid</td>
              <td>{gridIds.length}</td>
            </tr>
            <tr>
              <td>rendered in dock</td>
              <td>{dockIds.length}</td>
            </tr>
            <tr>
              <td>nested as subagent</td>
              <td>{nestedSubs.length}</td>
            </tr>
            <tr>
              <td>orphans (known but not rendered anywhere)</td>
              <td className={orphans.length ? 'debug-gap-pos' : ''}>{orphans.length}</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title={`Panel tree (${allPanels.size})`}>
        <table className="debug-table">
          <thead>
            <tr>
              <SortHeader col="title" sort={sort} onClick={toggleSort} glyph={sortGlyph('title')} />
              <SortHeader col="state" sort={sort} onClick={toggleSort} glyph={sortGlyph('state')} />
              <SortHeader col="slot" sort={sort} onClick={toggleSort} glyph={sortGlyph('slot')} />
              <SortHeader col="age" sort={sort} onClick={toggleSort} glyph={sortGlyph('age')} />
              <SortHeader
                col="project"
                sort={sort}
                onClick={toggleSort}
                glyph={sortGlyph('project')}
              />
              <SortHeader
                col="worktree"
                sort={sort}
                onClick={toggleSort}
                glyph={sortGlyph('worktree')}
              />
              {serverPanels !== null && (
                <SortHeader
                  col="server"
                  sort={sort}
                  onClick={toggleSort}
                  glyph={sortGlyph('server')}
                />
              )}
              <SortHeader col="id" sort={sort} onClick={toggleSort} glyph={sortGlyph('id')} />
            </tr>
          </thead>
          <tbody>{roots.flatMap((r) => renderSubtree(r, 0))}</tbody>
        </table>
      </Section>
    </div>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`debug-copy-id${copied ? ' copied' : ''}`}
      title={`copy ${id}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(id);
        } catch {
          // clipboard write can fail in non-secure contexts; fall back silently
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 900);
      }}
    >
      <code>{copied ? 'copied!' : id.slice(0, 10)}</code>
    </button>
  );
}

function SortHeader({
  col,
  sort,
  onClick,
  glyph,
}: {
  col: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onClick: (k: SortKey) => void;
  glyph: string;
}) {
  return (
    <th
      className={`debug-th-sort ${sort?.key === col ? 'is-sorted' : ''}`}
      onClick={() => onClick(col)}
    >
      {col}
      {glyph}
    </th>
  );
}

/** Resolve a row's color from the panel's loaded .hued theme. The server
 * walks worktrees up to the main repo (theme.ts → mainWorktreeRoot), so
 * `panel.theme` already reflects e.g. ~/src/weasel/.hued for any of its
 * worktrees. Returns null when no .hued is configured — the row stays
 * neutral rather than picking an arbitrary color. */
function projectColors(
  theme: { background: string; foreground: string } | null,
): { background: string; foreground: string } | null {
  return theme;
}

function projectLabel(cwd: string | null): string {
  if (!cwd) return '—';
  // Worktrees collapse to their parent repo — the worktree branch lives
  // in its own column now, so showing `<repo>/<branch>` here would just
  // duplicate that information.
  const wt = deriveWorktree(cwd);
  if (wt) return wt.repo;
  const segs = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length === 0) return cwd;
  return segs[segs.length - 1] || cwd;
}

function ServerContents({
  state,
  client,
}: {
  state: DebugState;
  client: DebugTileClientView;
}) {
  return <DebugContents state={state} clientPanelIds={new Set(client.allPanels.keys())} />;
}

function DebugContents({
  state,
  clientPanelIds,
}: {
  state: DebugState;
  clientPanelIds: Set<string>;
}) {
  const visibleServerPanels = state.panels.filter((p) => p.binned_at === null);
  const serverIds = new Set(visibleServerPanels.map((p) => p.id));
  const onlyOnClient = [...clientPanelIds].filter((id) => !serverIds.has(id));
  const onlyOnServer = visibleServerPanels.filter((p) => !clientPanelIds.has(p.id));
  const gapRows = state.reconciliation.rows.filter((r) => r.subagent_gap !== 0);

  return (
    <div className="debug-stack">
      <Section title={`Client ↔ server panel diff`}>
        <table className="debug-table">
          <tbody>
            <tr>
              <td>client visible</td>
              <td>{clientPanelIds.size}</td>
            </tr>
            <tr>
              <td>server visible (non-binned)</td>
              <td>{visibleServerPanels.length}</td>
            </tr>
            <tr>
              <td>only on client</td>
              <td>{onlyOnClient.length}</td>
            </tr>
            <tr>
              <td>only on server</td>
              <td>{onlyOnServer.length}</td>
            </tr>
            <tr>
              <td>delta subscribers</td>
              <td>{state.subscribers}</td>
            </tr>
          </tbody>
        </table>
        {onlyOnClient.length > 0 && (
          <details>
            <summary>only on client ({onlyOnClient.length})</summary>
            <ul className="debug-id-list">
              {onlyOnClient.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </details>
        )}
        {onlyOnServer.length > 0 && (
          <details>
            <summary>only on server ({onlyOnServer.length})</summary>
            <ul className="debug-id-list">
              {onlyOnServer.map((p) => (
                <li key={p.id}>
                  <code>{p.id}</code> · {p.kind} · {p.status} ·{' '}
                  <span className="muted">{p.title}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section
        title={`Subagents on disk vs in memory (${gapRows.length} sessions with gaps / ${state.reconciliation.rows.length} total)`}
      >
        {gapRows.length === 0 ? (
          <div className="muted small">no gaps — every disk subagent has a panel</div>
        ) : (
          <table className="debug-table">
            <thead>
              <tr>
                <th>session</th>
                <th>title</th>
                <th>project</th>
                <th title="parent panel status, or — when there's no panel for this session">parent status</th>
                <th title="agent-*.jsonl files in <session>/subagents/">sub files</th>
                <th title="subagent panels in the SessionStore for this parent">sub panels</th>
                <th title="files − panels (positive = phantom subagents in the UI)">gap</th>
                <th>parent age</th>
              </tr>
            </thead>
            <tbody>
              {gapRows.slice(0, 20).map((r) => (
                <tr key={`${r.root}|${r.session_id}`}>
                  <td>
                    <code title={r.parent_jsonl_path ?? ''}>{r.session_id.slice(0, 8)}</code>
                  </td>
                  <td className="debug-cell-truncate" title={r.panel_title ?? ''}>
                    {r.panel_title ?? '—'}
                  </td>
                  <td className="debug-cell-truncate" title={r.project ?? ''}>
                    {r.project ?? '—'}
                  </td>
                  <td>{r.panel_status ?? '—'}</td>
                  <td>{r.subagent_file_count}</td>
                  <td>{r.subagent_panel_count}</td>
                  <td className={r.subagent_gap > 0 ? 'debug-gap-pos' : 'debug-gap-neg'}>
                    {r.subagent_gap > 0 ? `+${r.subagent_gap}` : r.subagent_gap}
                  </td>
                  <td>{fmtAge(r.parent_jsonl_mtime, state.now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Roots">
        <table className="debug-table">
          <thead>
            <tr>
              <th>path</th>
              <th>sessions</th>
              <th>subagent files</th>
            </tr>
          </thead>
          <tbody>
            {state.reconciliation.rootCounts.map((r) => (
              <tr key={r.root}>
                <td>
                  <code>{r.root}</code>
                </td>
                <td>{r.sessions}</td>
                <td>{r.subagentFiles}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Bootstrap offsets (${state.offsets.length})`}>
        <details>
          <summary>show all</summary>
          <table className="debug-table">
            <thead>
              <tr>
                <th>file</th>
                <th>offset</th>
                <th>size</th>
                <th>caught up</th>
              </tr>
            </thead>
            <tbody>
              {state.offsets.map((o) => {
                const caughtUp = o.file_size !== null && o.byte_offset >= o.file_size;
                return (
                  <tr key={o.file_path}>
                    <td>
                      <code title={o.file_path}>{shortPath(o.file_path)}</code>
                    </td>
                    <td>{o.byte_offset.toLocaleString()}</td>
                    <td>{o.file_size?.toLocaleString() ?? '—'}</td>
                    <td>{caughtUp ? '✓' : o.file_size === null ? 'gone' : 'behind'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      </Section>

      <Section title={`All panels (${state.panels.length})`}>
        <details>
          <summary>show all</summary>
          <table className="debug-table">
            <thead>
              <tr>
                <th>id</th>
                <th>kind</th>
                <th>parent</th>
                <th>status</th>
                <th>events</th>
                <th>age</th>
                <th>binned</th>
              </tr>
            </thead>
            <tbody>
              {state.panels.map((p) => (
                <tr key={p.id}>
                  <td>
                    <code>{p.id.slice(0, 10)}</code>
                  </td>
                  <td>{p.kind}</td>
                  <td>{p.parent_panel_id ? <code>{p.parent_panel_id.slice(0, 8)}</code> : '—'}</td>
                  <td>{p.status}</td>
                  <td>{p.event_count}</td>
                  <td>{fmtAge(p.last_event_at, state.now)}</td>
                  <td>{p.binned_at ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="debug-section">
      <h3 className="debug-section-title">{title}</h3>
      {children}
    </section>
  );
}

function fmtAge(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const s = now - ts;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function shortPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join('/')}`;
}

/** Reuses the same chip the live panel header shows — same hash-derived
 * worktree color, same pill shape — so the debug row reads as the
 * "same thing in a table." Renders an em-dash when the cwd isn't a
 * worktree (main checkout / unknown). */
function WorktreeBadge({ cwd }: { cwd: string | null }) {
  const wt = deriveWorktree(cwd);
  if (!wt) return <span className="debug-muted">—</span>;
  return (
    <span
      className="panel-worktree-chip"
      style={{ ['--panel-worktree-color' as string]: worktreeColor(wt.key) }}
      title={`worktree: ${wt.key}`}
    >
      <span className="panel-worktree-swatch" aria-hidden="true" />
      {wt.name}
    </span>
  );
}
