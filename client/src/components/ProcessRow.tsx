import type { CSSProperties } from 'react';
import { useState } from 'react';
import { CopyableId } from '../lib/CopyableId.tsx';
import { CLI_ICONS } from '../lib/tools.ts';
import { deriveWorktree, worktreeColor } from '../lib/worktree.ts';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { trpc } from '../trpc.ts';

/** Map a detected runtime to the same SVG asset used by Bash tool
 * capsules. Falls back to null so the caller can render text only. */
function runtimeIcon(runtime: string | null): string | null {
  if (!runtime) return null;
  return CLI_ICONS[runtime] ?? null;
}

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

/** Compute the background tint for the session chip. Solid project
 * color when there's no worktree, or a left-to-right gradient from
 * project color to worktree color when there is. Returns null when
 * we don't have enough info (no panel for the session). */
function sessionChipBackground(panel: PanelState | null): string | null {
  if (!panel) return null;
  const repoRoot = panel.repo_root ?? null;
  if (!repoRoot) return null;
  const repo = repoRoot.split('/').filter(Boolean).pop() ?? '';
  if (!repo) return null;
  const projectColor = worktreeColor(repo);
  const wt = deriveWorktree(panel.cwd);
  if (!wt) return projectColor;
  return `linear-gradient(90deg, ${projectColor}, ${worktreeColor(wt.key)})`;
}

export function ProcessRow({ row, panel }: { row: Row; panel: PanelState | null }) {
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
        <td className="process-runtime">
          {(() => {
            const svg = runtimeIcon(row.runtime);
            if (svg) return (
              <>
                <span
                  className="runtime-icon"
                  aria-hidden="true"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG.
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                {row.runtime_version && <span className="runtime-version">{row.runtime_version}</span>}
              </>
            );
            return runtimeText;
          })()}
        </td>
        <td>{frameworkText}</td>
        <td className="process-command-cell">
          <span className="process-command" title={row.command}>{row.command}</span>
        </td>
        <td>
          {row.ports.length === 0 ? '—' : row.ports.map((p, i) => (
            <span key={`${p.proto}-${p.addr}-${p.port}-${i}`}>
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
        <td>
          {row.session_id ? (
            <span
              className="session-chip-wrap"
              style={(() => {
                const bg = sessionChipBackground(panel);
                return bg ? ({ ['--session-chip-bg' as string]: bg } as CSSProperties) : {};
              })()}
            >
              <CopyableId id={row.session_id} length={8} />
            </span>
          ) : (
            '(discovered)'
          )}
        </td>
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
          <td colSpan={10}><pre>{tail}</pre></td>
        </tr>
      )}
    </>
  );
}
