import { useEffect, useState } from 'react';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

const ONLY_KEY = 'brainhouse:processes:onlyClaudeLinked';

/** Commands Claude Code (or its harness) spawns for housekeeping —
 * keep-alive shims, sleep prevention, etc. They're real descendants
 * but provide no signal about *what work* the session is doing, so
 * we hide them from Claude-linked-only mode. */
const HOUSEKEEPING_HEADS = new Set(['caffeinate']);

function isHousekeeping(row: Row): boolean {
  const first = row.command.split(/\s+/)[0] ?? '';
  const head = first.split('/').pop() ?? first;
  return HOUSEKEEPING_HEADS.has(head);
}

export function ProcessesPanel({ allPanels }: { allPanels: Map<string, PanelState> }) {
  const all = useProcesses().slice().sort((a, b) => b.uptime_s - a.uptime_s);
  const [onlyClaudeLinked, setOnlyClaudeLinked] = useState<boolean>(() => {
    try { return localStorage.getItem(ONLY_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(ONLY_KEY, onlyClaudeLinked ? '1' : '0'); } catch {}
  }, [onlyClaudeLinked]);

  if (all.length === 0) return null;
  // A row is "Claude-linked" when we've attributed it to a session by
  // any tier — discovered rows are the host-wide listening services.
  // Also hide Claude's own housekeeping spawns (caffeinate, etc.) —
  // they're descendants but not interesting.
  const rows = onlyClaudeLinked
    ? all.filter(r => r.provenance !== 'discovered' && !isHousekeeping(r))
    : all;

  return (
    <section className="processes-panel">
      <header>
        <h2>
          Processes <span className="processes-count">({rows.length}{onlyClaudeLinked && all.length !== rows.length ? ` of ${all.length}` : ''})</span>
        </h2>
        <label className="processes-filter" title="Hide host-wide listeners; show only processes we've linked to a Claude Code session">
          <input
            type="checkbox"
            checked={onlyClaudeLinked}
            onChange={e => setOnlyClaudeLinked(e.target.checked)}
          />
          Claude-linked only
        </label>
      </header>
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
      {onlyClaudeLinked && rows.length === 0 && (
        <p className="processes-filter-empty">
          No processes are currently linked to a Claude Code session.
        </p>
      )}
    </section>
  );
}
