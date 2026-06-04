import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

export function ProcessesPanel() {
  const rows = useProcesses().slice().sort((a, b) => b.uptime_s - a.uptime_s);
  if (rows.length === 0) return null;
  return (
    <section className="processes-panel">
      <header><h2>Processes <span className="processes-count">({rows.length})</span></h2></header>
      <table className="processes-table">
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
    </section>
  );
}
