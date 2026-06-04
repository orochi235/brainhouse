import { useEffect, useState } from 'react';
import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

const ONLY_KEY = 'brainhouse:processes:onlyClaudeLinked';

export function ProcessesPanel() {
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
  const rows = onlyClaudeLinked
    ? all.filter(r => r.provenance !== 'discovered')
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
        <tbody>{rows.map(r => <ProcessRow key={r.process_id} row={r} />)}</tbody>
      </table>
      {onlyClaudeLinked && rows.length === 0 && (
        <p className="processes-filter-empty">
          No processes are currently linked to a Claude Code session.
        </p>
      )}
    </section>
  );
}
