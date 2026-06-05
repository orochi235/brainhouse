import { useEffect, useState } from 'react';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

/** localStorage keys for the four visibility toggles. Defaults: Claude
 * on, network off, raw off, wrappers off. Each axis is independent. */
const SHOW_CLAUDE_KEY = 'brainhouse:processes:showClaude';
const SHOW_NETWORK_KEY = 'brainhouse:processes:showNetwork';
const SHOW_RAW_KEY = 'brainhouse:processes:showRaw';
const SHOW_WRAPPERS_KEY = 'brainhouse:processes:showWrappers';

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

export function ProcessesPanel({ allPanels }: { allPanels: Map<string, PanelState> }) {
  const all = useProcesses().slice().sort(sortRows);
  const [showClaude, setShowClaude] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_CLAUDE_KEY) !== '0'; } catch { return true; }
  });
  const [showNetwork, setShowNetwork] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_NETWORK_KEY) === '1'; } catch { return false; }
  });
  const [showRaw, setShowRaw] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_RAW_KEY) === '1'; } catch { return false; }
  });
  const [showWrappers, setShowWrappers] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_WRAPPERS_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(SHOW_CLAUDE_KEY, showClaude ? '1' : '0'); } catch {}
  }, [showClaude]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_NETWORK_KEY, showNetwork ? '1' : '0'); } catch {}
  }, [showNetwork]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_RAW_KEY, showRaw ? '1' : '0'); } catch {}
  }, [showRaw]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_WRAPPERS_KEY, showWrappers ? '1' : '0'); } catch {}
  }, [showWrappers]);

  if (all.length === 0) return null;
  // Filter semantics:
  //   - Network rows (process has a listening port): shown when
  //     showNetwork. Non-Claude-attributed ones additionally require
  //     showRaw — they're host-wide noise unless explicitly opted in.
  //   - Non-network Claude-attributed rows (claude binary + agent
  //     shells / scripts): shown when showClaude.
  //   - Housekeeping spawns (caffeinate, etc.): hidden unless showRaw.
  //   - Transparent wrappers (npm / run-p / tsx / etc. that don't bind
  //     their own ports): hidden unless showWrappers.
  const rows = all.filter(r => {
    if (!showRaw && isHousekeeping(r)) return false;
    if (!showWrappers && isTransparentWrapper(r)) return false;
    if (isNetwork(r)) {
      if (!showNetwork) return false;
      if (!isClaudeAttributed(r) && !showRaw) return false;
      return true;
    }
    return showClaude;
  });

  return (
    <section className="processes-panel">
      <header>
        <h2>
          Processes <span className="processes-count">({rows.length}{rows.length !== all.length ? ` of ${all.length}` : ''})</span>
        </h2>
        <div className="processes-filter-group">
          <label className="processes-filter" title="Show Claude sessions: the claude binary itself plus any process attributed to a Claude session by the tree walker or hook records.">
            <input
              type="checkbox"
              checked={showClaude}
              onChange={e => setShowClaude(e.target.checked)}
            />
            Claude sessions
          </label>
          <label className="processes-filter" title="Show host-wide network listeners: anything bound to a TCP port (postgres, redis, system services, other people's dev servers, etc.) that isn't attributed to a Claude session. Requires 'Show all' to also be checked — these listeners can be very noisy so we ask for two opt-ins.">
            <input
              type="checkbox"
              checked={showNetwork}
              onChange={e => setShowNetwork(e.target.checked)}
            />
            Network processes
          </label>
          <label className="processes-filter" title="Show transparent wrapper launchers — npm, run-p, tsx watch, concurrently, etc. — that don't bind their own ports. By default they're collapsed away so the panel shows only the leaf processes that actually do the work.">
            <input
              type="checkbox"
              checked={showWrappers}
              onChange={e => setShowWrappers(e.target.checked)}
            />
            Wrappers
          </label>
          <label className="processes-filter" title="Bypass the noise filter: include Claude's own housekeeping spawns (caffeinate, etc.) that we'd normally hide because they don't carry signal about what work the session is doing.">
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
            <col style={{ width: '500px' }} />
            <col style={{ width: '130px' }} />
            <col style={{ width: '110px' }} />
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
              <th>Command<span className="th-resize" /></th>
              <th>Ports<span className="th-resize" /></th>
              <th>Project<span className="th-resize" /></th>
              <th>Session<span className="th-resize" /></th>
              <th>Uptime<span className="th-resize" /></th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>{rows.map(r => (
            <ProcessRow
              key={r.process_id}
              row={r}
              panel={r.session_id ? allPanels.get(r.session_id) ?? null : null}
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
