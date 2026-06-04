import { useState } from 'react';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { trpc } from '../trpc.ts';

const PROVENANCE_DOT: Record<Row['provenance'], string> = {
  hooked: '●', observed: '●', heuristic: '●', discovered: '○',
};

const PROVENANCE_CLASS: Record<Row['provenance'], string> = {
  hooked: 'process-dot process-dot-hooked',
  observed: 'process-dot process-dot-observed',
  heuristic: 'process-dot process-dot-heuristic',
  discovered: 'process-dot process-dot-discovered',
};

function fmtUptime(s: number): string {
  const totalSec = Math.max(0, Math.floor(s));
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '0.0.0.0' || addr === '*';
}

export function ProcessRow({ row }: { row: Row }) {
  const [tail, setTail] = useState<string | null>(null);
  const [loadingTail, setLoadingTail] = useState(false);

  const kill = () => {
    if (!window.confirm(`Send SIGTERM to PID ${row.pid}?`)) return;
    void trpc.processes.kill.mutate({ process_id: row.process_id });
  };

  const toggleTail = async () => {
    if (tail !== null) { setTail(null); return; }
    setLoadingTail(true);
    try {
      const r = await trpc.processes.tailStdout.query({ process_id: row.process_id, lines: 40 });
      setTail(r.content || '(no output)');
    } finally {
      setLoadingTail(false);
    }
  };

  const cwdShort = row.cwd ? (row.cwd.split('/').filter(Boolean).pop() ?? row.cwd) : '—';
  const runtimeText = row.runtime ? (row.runtime_version ? `${row.runtime} ${row.runtime_version}` : row.runtime) : '—';
  const frameworkText = row.framework
    ? (row.framework_version ? `${row.framework} ${row.framework_version}` : row.framework)
    : '—';

  return (
    <>
      <tr className="process-row">
        <td>
          <span className={PROVENANCE_CLASS[row.provenance]} title={row.provenance}>
            {PROVENANCE_DOT[row.provenance]}
          </span>
        </td>
        <td>{row.pid}</td>
        <td>{runtimeText}</td>
        <td>{frameworkText}</td>
        <td>
          {row.ports.length === 0 ? '—' : row.ports.map((p, i) => (
            <span key={`${p.proto}-${p.port}`}>
              {i > 0 && ' '}
              {isLoopback(p.addr) ? (
                <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer">:{p.port}</a>
              ) : (
                <span>:{p.port}</span>
              )}
            </span>
          ))}
        </td>
        <td>{cwdShort}</td>
        <td>{row.session_id ?? '(discovered)'}</td>
        <td>{fmtUptime(row.uptime_s)}</td>
        <td>
          {row.run_in_background && (
            <button onClick={toggleTail} aria-label={`Tail PID ${row.pid}`}>
              {loadingTail ? '…' : '▾'}
            </button>
          )}
          <button onClick={kill} aria-label={`Kill PID ${row.pid}`}>✕</button>
        </td>
      </tr>
      {tail !== null && (
        <tr className="process-tail">
          <td colSpan={9}><pre>{tail}</pre></td>
        </tr>
      )}
    </>
  );
}
