import { useEffect, useState } from 'react';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

/** Storage key for the show-all toggle. Default behavior (key absent
 * or '0') is Claude-linked-only — the noisy host-wide listing requires
 * the user opt-in. */
const SHOW_ALL_KEY = 'brainhouse:processes:showAll';

/** Commands Claude Code (or its harness) spawns for housekeeping —
 * keep-alive shims, sleep prevention, etc. They're real descendants
 * but provide no signal about *what work* the session is doing, so
 * we hide them when the show-all toggle is off. */
const HOUSEKEEPING_HEADS = new Set(['caffeinate']);

function isHousekeeping(row: Row): boolean {
  const first = row.command.split(/\s+/)[0] ?? '';
  const head = first.split('/').pop() ?? first;
  return HOUSEKEEPING_HEADS.has(head);
}

export function ProcessesPanel({ allPanels }: { allPanels: Map<string, PanelState> }) {
  const all = useProcesses().slice().sort((a, b) => b.uptime_s - a.uptime_s);
  const [showAll, setShowAll] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_ALL_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(SHOW_ALL_KEY, showAll ? '1' : '0'); } catch {}
  }, [showAll]);

  if (all.length === 0) return null;
  // Default view: Claude-linked rows only. Filter out `discovered`
  // host-wide listeners and Claude's own housekeeping spawns
  // (caffeinate, etc.) — but always keep the Claude binary itself
  // visible since it's the process the session is running, even when
  // brainhouse didn't witness the session start (e.g. session predates
  // hook installation). Toggle on to see everything.
  const rows = showAll
    ? all
    : all.filter(r => (r.runtime === 'claude' || r.provenance !== 'discovered') && !isHousekeeping(r));

  return (
    <section className="processes-panel">
      <header>
        <h2>
          Processes <span className="processes-count">({rows.length}{!showAll && all.length !== rows.length ? ` of ${all.length}` : ''})</span>
        </h2>
        <label className="processes-filter" title="Include host-wide listening services (postgres, redis, system apps, etc.) and Claude's own housekeeping processes.">
          <input
            type="checkbox"
            checked={showAll}
            onChange={e => setShowAll(e.target.checked)}
          />
          Show all processes
        </label>
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
      {!showAll && rows.length === 0 && (
        <p className="processes-filter-empty">
          No processes are currently linked to a Claude Code session.
        </p>
      )}
    </section>
  );
}
