import { useEffect, useState } from 'react';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

/** localStorage keys for the three visibility toggles. Defaults: Claude
 * on, network off, raw off. Each axis is independent. */
const SHOW_CLAUDE_KEY = 'brainhouse:processes:showClaude';
const SHOW_NETWORK_KEY = 'brainhouse:processes:showNetwork';
const SHOW_RAW_KEY = 'brainhouse:processes:showRaw';

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

/** A row is "Claude-related" when it's either the Claude binary itself
 * or a tracked descendant of a Claude session (any non-discovered
 * provenance tier). Network rows are everything else. */
function isClaudeRelated(row: Row): boolean {
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
  useEffect(() => {
    try { localStorage.setItem(SHOW_CLAUDE_KEY, showClaude ? '1' : '0'); } catch {}
  }, [showClaude]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_NETWORK_KEY, showNetwork ? '1' : '0'); } catch {}
  }, [showNetwork]);
  useEffect(() => {
    try { localStorage.setItem(SHOW_RAW_KEY, showRaw ? '1' : '0'); } catch {}
  }, [showRaw]);

  if (all.length === 0) return null;
  // Filter semantics:
  //   - Claude-related rows: shown when showClaude.
  //   - Non-Claude network listeners: shown only when BOTH showNetwork
  //     AND showRaw are on. They're noisy enough that a single toggle
  //     isn't a strong enough signal of intent; the second checkbox is
  //     a "yes really" confirmation.
  //   - Housekeeping spawns (caffeinate, etc.): hidden unless showRaw.
  const rows = all.filter(r => {
    if (!showRaw && isHousekeeping(r)) return false;
    if (isClaudeRelated(r)) return showClaude;
    return showNetwork && showRaw;
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
              <th>cwd<span className="th-resize" /></th>
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
