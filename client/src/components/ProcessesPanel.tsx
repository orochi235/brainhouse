import { useEffect, useState } from 'react';
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
 * with its tree depth. Children are sorted by uptime desc within each
 * sibling group so the longest-running stay at the top. */
function flattenTree(
  roots: Row[],
  childrenByPid: Map<number, Row[]>,
): Array<{ row: Row; depth: number }> {
  const out: Array<{ row: Row; depth: number }> = [];
  function visit(r: Row, depth: number) {
    out.push({ row: r, depth });
    const kids = (childrenByPid.get(r.pid) ?? []).slice().sort((a, b) => b.uptime_s - a.uptime_s);
    for (const k of kids) visit(k, depth + 1);
  }
  const sortedRoots = roots.slice().sort((a, b) => b.uptime_s - a.uptime_s);
  for (const r of sortedRoots) visit(r, 0);
  return out;
}

export function ProcessesPanel({ allPanels }: { allPanels: Map<string, PanelState> }) {
  const all = useProcesses();
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'sessions'; } catch { return 'sessions'; }
  });
  const [showRaw, setShowRaw] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_RAW_KEY) === '1'; } catch { return false; }
  });
  const [showWrappers, setShowWrappers] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_WRAPPERS_KEY) === '1'; } catch { return false; }
  });
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

  let display: Array<{ row: Row; depth: number }>;
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
    const roots = inSessionTree.filter(r => r.runtime === 'claude');
    display = flattenTree(roots, childrenByPid);
  } else {
    // Network: flat list of port-binders, with Show-all gating for
    // non-Claude-attributed listeners (host-wide noise).
    const filtered = baseFiltered.filter(r => {
      if (!isNetwork(r)) return false;
      if (!isClaudeAttributed(r) && !showRaw) return false;
      return true;
    });
    display = filtered.slice().sort(sortRows).map(row => ({ row, depth: 0 }));
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
        <table className="processes-table">
          <colgroup>
            <col style={{ width: '30px' }} />
            <col style={{ width: '60px' }} />
            <col style={{ width: '100px' }} />
            <col style={{ width: '150px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '500px' }} />
            <col style={{ width: '130px' }} />
            <col style={{ width: '140px' }} />
            <col style={{ width: '90px' }} />
            <col style={{ width: '40px' }} />
          </colgroup>
          <thead>
            <tr>
              <th aria-label="status"><span className="th-resize" /></th>
              <th>PID<span className="th-resize" /></th>
              <th>Runtime<span className="th-resize" /></th>
              <th>Framework<span className="th-resize" /></th>
              <th>Project<span className="th-resize" /></th>
              <th>Command<span className="th-resize" /></th>
              <th>Ports<span className="th-resize" /></th>
              <th>Session<span className="th-resize" /></th>
              <th>Uptime<span className="th-resize" /></th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>{rows.map(({ row, depth }) => (
            <ProcessRow
              key={row.process_id}
              row={row}
              depth={depth}
              panel={row.session_id ? allPanels.get(row.session_id) ?? null : null}
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
