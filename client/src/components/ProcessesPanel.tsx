import { useProcesses } from '../useProcesses.ts';
import { ProcessRow } from './ProcessRow.tsx';

export function ProcessesPanel() {
  const rows = useProcesses().slice().sort((a, b) => b.uptime_s - a.uptime_s);
  return (
    <section className="processes-panel">
      <header><h2>Processes</h2></header>
      {rows.length === 0 ? (
        <p className="empty">No processes observed yet. Brainhouse watches descendants of each Claude session and listening ports on this host.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th><th>PID</th><th>Runtime</th><th>Framework</th>
              <th>Ports</th><th>cwd</th><th>Session</th><th>Uptime</th><th></th>
            </tr>
          </thead>
          <tbody>{rows.map(r => <ProcessRow key={r.process_id} row={r} />)}</tbody>
        </table>
      )}
    </section>
  );
}
