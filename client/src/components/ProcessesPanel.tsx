import { useEffect, useState } from 'react';
import { badgeColor } from '../lib/worktree.ts';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

/** localStorage keys. View-mode picks the top-level layout (sessions
 * tree vs. flat network list). Show-all and Wrappers are view-scoped
 * toggles. */
const VIEW_MODE_KEY = 'brainhouse:processes:viewMode';
const SHOW_RAW_KEY = 'brainhouse:processes:showRaw';
const SHOW_WRAPPERS_KEY = 'brainhouse:processes:showWrappers';

type ViewMode = 'sessions' | 'network';
type SortKey = 'pid' | 'project' | 'account' | 'command' | 'session' | 'idle' | 'uptime' | null;

/** Pick the comparable value for a row under a given sort key. Strings
 * sort lexicographically; numbers naturally; nulls land at the end of
 * the desc order (i.e., always treated as "smallest"). */
function sortValue(
  row: Row,
  panel: PanelState | null,
  key: Exclude<SortKey, null>,
  now: number,
): string | number {
  switch (key) {
    case 'pid': return row.pid;
    case 'project': return row.project ?? '';
    case 'account': return panel?.account_label ?? row.account_label ?? '';
    case 'command': return panel?.title ?? row.command;
    case 'session': return row.session_id ?? '';
    case 'idle': return panel ? Math.max(0, now - panel.last_event_at) : Number.MAX_SAFE_INTEGER;
    case 'uptime': return row.uptime_s;
  }
}

function cmp(a: string | number, b: string | number, dir: 'asc' | 'desc'): number {
  const mul = dir === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return mul * (a - b);
  return mul * String(a).localeCompare(String(b));
}

/** Header cell that toggles a column sort. Click cycle: desc → asc → off
 * (back to the view's default ordering). Arrow renders only when the
 * column is active. Resize handle preserved so widths still work. */
function SortHeader({
  label,
  sortKey,
  sort,
  toggle,
  width,
}: {
  label: string;
  sortKey: Exclude<SortKey, null>;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  toggle: (k: Exclude<SortKey, null>) => void;
  width: string;
}) {
  const active = sort.key === sortKey;
  const arrow = active ? (sort.dir === 'desc' ? '▾' : '▴') : '';
  return (
    <th style={{ width }} className={active ? 'sortable-th is-sorted' : 'sortable-th'}>
      <button
        type="button"
        className="th-sort-button"
        onClick={() => toggle(sortKey)}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {arrow && <span className="th-sort-arrow">{arrow}</span>}
      </button>
      <span className="th-resize" />
    </th>
  );
}

/** Commands Claude Code (or its harness) spawns for housekeeping —
 * keep-alive shims, sleep prevention, etc. They're real descendants
 * but provide no signal about *what work* the session is doing, so
 * we always hide them. */
const HOUSEKEEPING_HEADS = new Set(['caffeinate']);

function isHousekeeping(row: Row): boolean {
  const first = row.command.split(/\s+/)[0] ?? '';
  const head = first.split('/').pop() ?? first;
  return HOUSEKEEPING_HEADS.has(head);
}

/** Transparent passthrough launchers — npm/yarn/pnpm/npx, run-p/run-s,
 * concurrently, tsx watch. They show up in `ps` but rarely do the
 * actual work themselves; collapsing them by default leaves the panel
 * showing the leaf processes that bind ports / load the code. */
const WRAPPER_HEADS = new Set([
  'npm', 'npx', 'yarn', 'pnpm',
  'run-p', 'run-s', 'npm-run-all',
  'concurrently',
  'tsx',
]);

function isTransparentWrapper(row: Row): boolean {
  // Walk the first few argv tokens looking for a known wrapper head.
  // We skip past `node` / `/usr/local/bin/node` etc. so the
  // `node .../tsx watch ...` style invocations still match.
  const argv = row.command.split(/\s+/).slice(0, 4);
  const hasWrapperToken = argv.some(t => {
    const head = (t.split('/').pop() ?? t).replace(/\.(js|mjs|cjs)$/, '');
    return WRAPPER_HEADS.has(head);
  });
  if (!hasWrapperToken) return false;
  // A wrapper that doesn't own any ports is transparent. If it has
  // inherited ports, those came from a descendant we're already
  // showing — collapsing the wrapper loses no information.
  return row.ports.length === 0 || row.ports.every(p => p.inherited === true);
}

/** Bucket assignment is by *what the process is*, not by what we
 * managed to attribute it to. A vite dev server bound to :5173 is a
 * network process even when brainhouse pinned it to a Claude session
 * via the cwd heuristic — the user's mental model is "this thing
 * listens on a port" vs. "this thing is part of the agent's
 * thinking". */
function isNetwork(row: Row): boolean {
  return row.ports.length > 0;
}

/** A non-network row that's been attributed to (or IS) a Claude
 * session. Anything else with no ports gets dropped by the server's
 * qualifiesForBroadcast filter, so we don't see it on the client. */
function isClaudeAttributed(row: Row): boolean {
  return row.runtime === 'claude' || row.provenance !== 'discovered';
}

/** Sort rank: higher-confidence attribution first, then uptime desc.
 * Without this, host-wide system processes (13-hour-old Music.app,
 * Adobe, Syncthing) dominate the top and the Claude-attributed rows —
 * usually what the user actually wants to see — get buried below the
 * fold. */
const PROVENANCE_RANK: Record<Row['provenance'], number> = {
  hooked: 0,
  observed: 1,
  heuristic: 2,
  discovered: 3,
};

function sortRows(a: Row, b: Row): number {
  const rankDelta = PROVENANCE_RANK[a.provenance] - PROVENANCE_RANK[b.provenance];
  if (rankDelta !== 0) return rankDelta;
  return b.uptime_s - a.uptime_s;
}

/** Build a parent → children map for a row set. A row's parent is the
 * tracked row whose pid matches the row's ppid; if that misses (e.g.
 * the row was reparented to launchd), we fall back to the deepest
 * tracked ancestor from original_ancestors. Returns a tuple of
 * (childrenByParentPid, rootPids) where roots are rows with no
 * tracked parent. */
function buildParentLinks(rows: Row[]): {
  childrenByPid: Map<number, Row[]>;
  rootPids: Set<number>;
} {
  const byPid = new Map<number, Row>();
  for (const r of rows) byPid.set(r.pid, r);
  const childrenByPid = new Map<number, Row[]>();
  const rootPids = new Set<number>();
  for (const r of rows) {
    let parent: Row | null = null;
    const direct = byPid.get(r.ppid);
    if (direct && direct.pid !== r.pid) parent = direct;
    else {
      for (const ancPid of r.original_ancestors) {
        const cand = byPid.get(ancPid);
        if (cand && cand.pid !== r.pid) { parent = cand; break; }
      }
    }
    if (parent) {
      const list = childrenByPid.get(parent.pid);
      if (list) list.push(r);
      else childrenByPid.set(parent.pid, [r]);
    } else {
      rootPids.add(r.pid);
    }
  }
  return { childrenByPid, rootPids };
}

/** Flatten the tree rooted at `roots` in DFS order, tagging each row
 * with its tree depth and a `hasChildren` flag. Children are sorted by
 * uptime desc within each sibling group. When a root pid is NOT in the
 * `expanded` set, its descendants are skipped and only the root is
 * emitted (with `hasChildren=true` so the row can render its expand
 * affordance). */
function flattenTree(
  roots: Row[],
  childrenByPid: Map<number, Row[]>,
  expanded: Set<number>,
): Array<{ row: Row; depth: number; hasChildren: boolean }> {
  const out: Array<{ row: Row; depth: number; hasChildren: boolean }> = [];
  function visit(r: Row, depth: number, skipChildren: boolean) {
    const kids = childrenByPid.get(r.pid) ?? [];
    out.push({ row: r, depth, hasChildren: kids.length > 0 });
    if (skipChildren) return;
    const sorted = kids.slice().sort((a, b) => b.uptime_s - a.uptime_s);
    for (const k of sorted) visit(k, depth + 1, false);
  }
  const sortedRoots = roots.slice().sort((a, b) => b.uptime_s - a.uptime_s);
  for (const r of sortedRoots) {
    // Only root-level collapse is supported; nested descendants are
    // always shown when their root is expanded.
    visit(r, 0, !expanded.has(r.pid));
  }
  return out;
}

export function ProcessesPanel({
  allPanels,
  accountColorByLabel,
}: {
  allPanels: Map<string, PanelState>;
  /** account_label → hex color from prefs.roots[]. Drives the
   * --account-color CSS var on the Account badge so its tint matches
   * the session card / project widget account badge. */
  accountColorByLabel?: Map<string, string>;
}) {
  const all = useProcesses();

  // Project-path → badge color lookup. Built from any panel whose
  // repo_root or cwd matches the project; we pull the configured
  // theme.background and pass it through badgeColor() which preserves
  // the hue but lifts saturation/lightness to chip-friendly floors
  // (themes are usually too dark to read on a small badge).
  const projectThemes = new Map<string, string>();
  for (const p of allPanels.values()) {
    const key = p.repo_root ?? p.cwd;
    if (!key || !p.theme) continue;
    if (!projectThemes.has(key)) projectThemes.set(key, badgeColor(p.theme.background));
  }
  // Show the Account column only when more than one distinct label
  // appears across panels OR rows — counting row.account_label here
  // catches the brainhouse self-stamp case (it's a synthetic label
  // that never lives on a panel).
  const accountLabels = new Set<string>();
  for (const p of allPanels.values()) if (p.account_label) accountLabels.add(p.account_label);
  for (const r of all) if (r.account_label) accountLabels.add(r.account_label);
  const showAccount = accountLabels.size > 1;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'sessions'; } catch { return 'sessions'; }
  });
  const [showRaw, setShowRaw] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_RAW_KEY) === '1'; } catch { return false; }
  });
  const [showWrappers, setShowWrappers] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_WRAPPERS_KEY) === '1'; } catch { return false; }
  });
  /** Roots whose subtrees are currently expanded. Default: empty
   * (everything collapsed). Per-pid so toggling one tree doesn't
   * disturb the others. Not persisted — collapse state resets when
   * the page reloads, matching typical OS process-viewer behavior. */
  const [expandedRoots, setExpandedRoots] = useState<Set<number>>(() => new Set());
  /** Active sort. `key === null` falls back to the view's default
   * order (sessions: natural tree order; network: attribution-tier
   * descending then uptime). Click cycles desc → asc → off. */
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: null, dir: 'desc' });
  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' };
      if (prev.dir === 'desc') return { key, dir: 'asc' };
      return { key: null, dir: 'desc' };
    });
  };
  const toggleRoot = (pid: number) => {
    setExpandedRoots(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };
  // 1-Hz tick to refresh the per-row Idle column (sessions view only).
  // Uptime is server-pushed so doesn't need this; idle = now − panel.last_event_at
  // is purely a client-side derivation.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (viewMode !== 'sessions') return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [viewMode]);
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch {}
  }, [viewMode]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_RAW_KEY, showRaw ? '1' : '0'); } catch {}
  }, [showRaw]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_WRAPPERS_KEY, showWrappers ? '1' : '0'); } catch {}
  }, [showWrappers]);

  if (all.length === 0) return null;

  // Common noise gate — applies to both views.
  const baseFiltered = all.filter(r => {
    if (!showRaw && isHousekeeping(r)) return false;
    if (!showWrappers && isTransparentWrapper(r)) return false;
    return true;
  });

  let display: Array<{ row: Row; depth: number; hasChildren?: boolean; isRoot?: boolean }>;
  if (viewMode === 'sessions') {
    // Sessions tree: keep only Claude binaries and their descendants
    // (per ppid + original_ancestors). Roots are the claude-runtime
    // rows. Loose rows that didn't trace back to a Claude session get
    // dropped — they belong in Network view.
    const claudePids = new Set(baseFiltered.filter(r => r.runtime === 'claude').map(r => r.pid));
    // First pass: include only rows whose direct or ancestor chain
    // leads to a claude row.
    const inSessionTree = baseFiltered.filter(r => {
      if (r.runtime === 'claude') return true;
      const ancestors = [r.ppid, ...r.original_ancestors];
      return ancestors.some(p => claudePids.has(p));
    });
    const { childrenByPid } = buildParentLinks(inSessionTree);
    let roots = inSessionTree.filter(r => r.runtime === 'claude');
    // Column-sort applies to the root level only; descendants stay in
    // natural tree order under their root so the hierarchy reads
    // coherently.
    if (sort.key) {
      const k = sort.key;
      roots = roots.slice().sort((a, b) => {
        const pa = a.session_id ? allPanels.get(a.session_id) ?? null : null;
        const pb = b.session_id ? allPanels.get(b.session_id) ?? null : null;
        return cmp(sortValue(a, pa, k, now), sortValue(b, pb, k, now), sort.dir);
      });
    }
    display = flattenTree(roots, childrenByPid, expandedRoots).map(n => ({
      row: n.row,
      depth: n.depth,
      hasChildren: n.hasChildren,
      isRoot: n.depth === 0,
    }));
  } else {
    // Network: flat list of port-binders, with Show-all gating for
    // non-Claude-attributed listeners (host-wide noise).
    const filtered = baseFiltered.filter(r => {
      if (!isNetwork(r)) return false;
      if (!isClaudeAttributed(r) && !showRaw) return false;
      return true;
    });
    const ordered = sort.key
      ? filtered.slice().sort((a, b) => {
          const pa = a.session_id ? allPanels.get(a.session_id) ?? null : null;
          const pb = b.session_id ? allPanels.get(b.session_id) ?? null : null;
          return cmp(sortValue(a, pa, sort.key!, now), sortValue(b, pb, sort.key!, now), sort.dir);
        })
      : filtered.slice().sort(sortRows);
    display = ordered.map(row => ({ row, depth: 0 }));
  }
  const rows = display;

  return (
    <section className="processes-panel">
      <header>
        <h2>
          Processes <span className="processes-count">({rows.length}{rows.length !== all.length ? ` of ${all.length}` : ''})</span>
        </h2>
        <div className="processes-filter-group">
          <div className="processes-view-radio" role="radiogroup" aria-label="View mode">
            <label className="processes-filter" title="Tree view: each Claude session shown as a pstree, with its descendant processes (including any port-binding ones) nested underneath.">
              <input
                type="radio"
                name="processes-view-mode"
                checked={viewMode === 'sessions'}
                onChange={() => setViewMode('sessions')}
              />
              Sessions
            </label>
            <label className="processes-filter" title="Flat list of every process bound to a listening TCP port, sorted by attribution confidence and uptime.">
              <input
                type="radio"
                name="processes-view-mode"
                checked={viewMode === 'network'}
                onChange={() => setViewMode('network')}
              />
              Network
            </label>
          </div>
          <label className="processes-filter" title="Show transparent wrapper launchers — npm, run-p, tsx watch, concurrently, etc. — that don't bind their own ports. By default they're collapsed away so the panel shows only the leaf processes that actually do the work.">
            <input
              type="checkbox"
              checked={showWrappers}
              onChange={e => setShowWrappers(e.target.checked)}
            />
            Wrappers
          </label>
          <label className="processes-filter" title="Bypass the noise filter: include Claude's own housekeeping spawns (caffeinate, etc.) and host-wide network listeners that aren't attributed to a Claude session.">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={e => setShowRaw(e.target.checked)}
            />
            Show all
          </label>
        </div>
      </header>
      {rows.length > 0 && (
        // Widths live on the <th> inline so the browser's `resize:
        // horizontal` on each <th> actually drives column width. With
        // <colgroup>, table-layout: fixed snapshots the col widths and
        // ignores any th resize. PID is generous enough to hold a
        // 5-digit pid + ~3 levels of tree indent without wrapping.
        <table className="processes-table">
          <thead>
            <tr>
              <th aria-label="status" style={{ width: '30px' }}><span className="th-resize" /></th>
              <SortHeader label="PID" sortKey="pid" sort={sort} toggle={toggleSort} width="100px" />
              {viewMode === 'network' && (
                <>
                  <th style={{ width: '100px' }}>Runtime<span className="th-resize" /></th>
                  <th style={{ width: '150px' }}>Framework<span className="th-resize" /></th>
                </>
              )}
              <SortHeader label="Project" sortKey="project" sort={sort} toggle={toggleSort} width="110px" />
              {showAccount && (
                <SortHeader label="Account" sortKey="account" sort={sort} toggle={toggleSort} width="90px" />
              )}
              <SortHeader
                label={viewMode === 'sessions' ? 'Title' : 'Command'}
                sortKey="command"
                sort={sort}
                toggle={toggleSort}
                width="500px"
              />
              {viewMode === 'network' && <th style={{ width: '130px' }}>Ports<span className="th-resize" /></th>}
              <SortHeader label="Session" sortKey="session" sort={sort} toggle={toggleSort} width="140px" />
              {viewMode === 'sessions' && (
                <SortHeader label="Idle" sortKey="idle" sort={sort} toggle={toggleSort} width="70px" />
              )}
              <SortHeader label="Uptime" sortKey="uptime" sort={sort} toggle={toggleSort} width="90px" />
              <th aria-label="actions" style={{ width: '40px' }} />
            </tr>
          </thead>
          <tbody>{rows.map(({ row, depth, hasChildren, isRoot }) => (
            <ProcessRow
              key={row.process_id}
              row={row}
              depth={depth}
              viewMode={viewMode}
              showAccount={showAccount}
              panel={row.session_id ? allPanels.get(row.session_id) ?? null : null}
              projectColor={row.project ? projectThemes.get(row.project) ?? null : null}
              accountColor={(() => {
                const panelLabel = row.session_id ? allPanels.get(row.session_id)?.account_label : null;
                const label = panelLabel ?? row.account_label;
                return label ? accountColorByLabel?.get(label) ?? null : null;
              })()}
              expandable={isRoot && hasChildren}
              expanded={expandedRoots.has(row.pid)}
              onToggleExpand={isRoot && hasChildren ? () => toggleRoot(row.pid) : undefined}
              now={viewMode === 'sessions' ? now : null}
            />
          ))}</tbody>
        </table>
      )}
      {rows.length === 0 && all.length > 0 && (
        <p className="processes-filter-empty">
          No processes match the current filters. Toggle a checkbox above to broaden the view.
        </p>
      )}
    </section>
  );
}
