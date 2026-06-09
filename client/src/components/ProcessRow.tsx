import type { CSSProperties } from 'react';
import { useState } from 'react';
import { CopyableId } from '../lib/CopyableId.tsx';
import { formatIdle } from '../lib/format.ts';
import { CLI_ICONS } from '../lib/tools.ts';
import { badgeColor, deriveWorktree, worktreeColor } from '../lib/worktree.ts';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow as Row } from '../useProcesses.ts';
import { trpc } from '../trpc.ts';
import { HoverPopover } from './HoverPopover.tsx';

/** Map a detected runtime to the same SVG asset used by Bash tool
 * capsules. Falls back to null so the caller can render text only. */
function runtimeIcon(runtime: string | null): string | null {
  if (!runtime) return null;
  return CLI_ICONS[runtime] ?? null;
}

const PROVENANCE_DOT: Record<Row['provenance'], string> = {
  hooked: '●', observed: '●', heuristic: '●', discovered: '○',
};

/** Human-readable explanation of each provenance tier — surfaced as
 * a title attribute on the status dot. */
const PROVENANCE_TOOLTIP: Record<Row['provenance'], string> = {
  hooked:
    'hooked — the process is a descendant of a known Claude session and we have a matching Bash intent record. Highest confidence: we know which agent command spawned it.',
  observed:
    'observed — the process is a descendant of a known Claude session via the ps tree, but no PreToolUse Bash hook record matched it. Common for sub-shells or processes spawned outside the Bash tool.',
  heuristic:
    "heuristic — the process isn't in any session's tree but its cwd matches a session's cwd. Best-effort attribution; can be wrong if multiple sessions share a directory.",
  discovered:
    'discovered — the process is bound to a listening port and was found by the host-wide lsof sweep. No Claude session attribution.',
};

const PROVENANCE_CLASS: Record<Row['provenance'], string> = {
  hooked: 'process-dot process-dot-hooked',
  observed: 'process-dot process-dot-observed',
  heuristic: 'process-dot process-dot-heuristic',
  discovered: 'process-dot process-dot-discovered',
};

const fmtUptime = formatIdle;

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '0.0.0.0' || addr === '*';
}

/** Compute the background tint for the session chip. Solid project
 * color when there's no worktree, or a left-to-right gradient from
 * project color to worktree color when there is. Returns null when
 * we don't have enough info (no panel + no upstream project color). */
function sessionChipBackground(panel: PanelState | null, fallbackProjectColor: string | null): string | null {
  if (!panel) return fallbackProjectColor;
  // Prefer the configured panel theme (e.g. brainhouse's purple) over
  // the hash-derived worktreeColor fallback. Theme backgrounds are
  // typically dark and desaturated for use as panel backgrounds;
  // badgeColor() lifts them into vibrant chip-friendly territory while
  // preserving their hue identity. When the panel has no repo_root yet
  // (sessions started outside a git repo, or pre-repo-detection), fall
  // through to the upstream-computed project color so the chip still
  // matches the row's Project badge instead of going gray.
  const repoRoot = panel.repo_root ?? null;
  const repo = repoRoot ? repoRoot.split('/').filter(Boolean).pop() ?? '' : '';
  const projectColor = panel.theme?.background
    ? badgeColor(panel.theme.background)
    : repo
      ? worktreeColor(repo)
      : fallbackProjectColor;
  if (!projectColor) return null;
  const wt = deriveWorktree(panel.cwd);
  if (!wt) return projectColor;
  return `linear-gradient(90deg, ${projectColor}, ${worktreeColor(wt.key)})`;
}

export function ProcessRow({
  row,
  panel,
  depth = 0,
  viewMode = 'network',
  showAccount = false,
  accountColor = null,
  projectColor = null,
  expandable = false,
  expanded = false,
  onToggleExpand,
  now = null,
}: {
  row: Row;
  panel: PanelState | null;
  depth?: number;
  /** Sessions view hides Runtime + Framework — the tree structure
   * carries the project-identity work those columns did in the flat
   * Network view. */
  viewMode?: 'sessions' | 'network';
  /** Set by ProcessesPanel when the user has more than one Claude
   * account configured. When false the Account column is omitted from
   * both the thead and tbody. */
  showAccount?: boolean;
  /** Resolved project theme color (e.g. panel.theme.background for the
   * matching panel). Falls back to worktreeColor() when null. */
  projectColor?: string | null;
  /** Per-account color from prefs.roots[].color. When set, drives the
   * --account-color CSS var on the Account badge so it tints the
   * same way panel-account badges do in session title bars. */
  accountColor?: string | null;
  /** True when this row represents a tree root that has children — the
   * UI renders an expand/collapse caret in the status column. */
  expandable?: boolean;
  /** Whether the children are currently visible. Drives the caret
   * direction. */
  expanded?: boolean;
  /** Click handler for the caret. Undefined disables the affordance. */
  onToggleExpand?: () => void;
  /** Wall-clock seconds, ticking from the parent panel. When non-null
   * (sessions view), the row renders an Idle column = now − panel.last_event_at.
   * Null in network view, where the column doesn't exist. */
  now?: number | null;
}) {
  const kill = () => {
    if (!window.confirm(`Send SIGTERM to PID ${row.pid}?`)) return;
    void trpc.processes.kill.mutate({ process_id: row.process_id });
  };

  const runtimeText = row.runtime ? (row.runtime_version ? `${row.runtime} ${row.runtime_version}` : row.runtime) : '—';
  const frameworkText = row.framework
    ? (row.framework_version ? `${row.framework} ${row.framework_version}` : row.framework)
    : '—';

  return (
    <>
      <tr className="process-row">
        <td className="process-status-cell">
          {/* On expandable tree roots the status light doubles as the
            * expand/collapse affordance. Clicking it triggers the same
            * spin-and-morph motion used on panel pin/unpin: the dot
            * spins 720° while the glyph swaps from a circle to a
            * smaller downward triangle (or back). */}
          <span
            className={[
              PROVENANCE_CLASS[row.provenance],
              // Brainhouse server's own pid: solid purple diamond
              // instead of the round provenance dot. Framework is
              // stamped server-side on the self pid only, so this
              // styling never bleeds onto descendants or unrelated
              // rows.
              row.framework === 'brainhouse' ? 'process-dot-self' : '',
              expandable ? 'process-dot-expandable' : '',
              expandable && expanded ? 'is-expanded' : '',
            ].filter(Boolean).join(' ')}
            title={
              expandable
                ? (expanded ? 'collapse subtree' : 'expand subtree')
                : row.framework === 'brainhouse'
                  ? 'brainhouse server'
                  : PROVENANCE_TOOLTIP[row.provenance]
            }
            role={expandable ? 'button' : undefined}
            aria-expanded={expandable ? expanded : undefined}
            aria-label={expandable ? (expanded ? 'collapse' : 'expand') : undefined}
            tabIndex={expandable ? 0 : undefined}
            onClick={expandable && onToggleExpand ? onToggleExpand : undefined}
            onKeyDown={expandable && onToggleExpand ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleExpand();
              }
            } : undefined}
          >
            {expandable && expanded
              ? '▼'
              : row.framework === 'brainhouse'
                ? '◆'
                : PROVENANCE_DOT[row.provenance]}
          </span>
        </td>
        <td className="process-pid-cell" style={depth > 0 ? { paddingLeft: `calc(0.5rem + ${depth}rem)` } : undefined}>
          {depth > 0 && <span className="process-tree-rail" aria-hidden="true" />}
          {row.pid}
        </td>
        {viewMode === 'network' && (
          <>
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
          </>
        )}
        <td title={row.project ?? undefined}>
          {row.project ? (() => {
            const name = row.project.split('/').filter(Boolean).pop() ?? row.project;
            return (
              <span
                className="project-badge"
                style={{ ['--project-badge-bg' as string]: projectColor ?? worktreeColor(name) } as CSSProperties}
              >
                {name}
              </span>
            );
          })() : '—'}
        </td>
        {showAccount && (() => {
          // Prefer the live panel's label (always current); fall back to
          // the server-stamped row.account_label so non-panel rows
          // (brainhouse self, sessions that have ended) still show.
          const label = panel?.account_label ?? row.account_label;
          return (
            <td className="process-account-cell">
              {label ? (
                <span
                  className="panel-account"
                  style={accountColor ? ({ ['--account-color' as string]: accountColor } as CSSProperties) : undefined}
                  title={`account: ${label}`}
                >
                  {label}
                </span>
              ) : '—'}
            </td>
          );
        })()}
        <td className="process-command-cell">
          <HoverPopover
            popoverClassName="process-info-popover"
            content={
              <dl className="process-info-grid">
                <dt>PID</dt><dd>{row.pid}</dd>
                <dt>Uptime</dt><dd>{fmtUptime(row.uptime_s)}</dd>
                {row.runtime && <><dt>Runtime</dt><dd>{runtimeText}</dd></>}
                {row.framework && <><dt>Framework</dt><dd>{frameworkText}</dd></>}
                {row.ports.length > 0 && (
                  <>
                    <dt>Ports</dt>
                    <dd>{row.ports.map(p => `${p.addr}:${p.port}`).join(' ')}</dd>
                  </>
                )}
                {row.project && <><dt>Project</dt><dd>{row.project}</dd></>}
                {row.session_id && <><dt>Session</dt><dd>{row.session_id}</dd></>}
                {panel?.title && <><dt>Title</dt><dd>{panel.title}</dd></>}
                {row.hook_command && <><dt>Intent</dt><dd>{row.hook_command}</dd></>}
                <dt>Provenance</dt><dd>{row.provenance}</dd>
                <dt>Command</dt><dd className="process-info-command">{row.command}</dd>
              </dl>
            }
          >
            <span
              className={
                viewMode === 'sessions' && panel?.title
                  ? 'process-command is-title'
                  : 'process-command'
              }
            >
              {viewMode === 'sessions' && panel?.title ? panel.title : row.command}
            </span>
          </HoverPopover>
        </td>
        {viewMode !== 'sessions' && (
          <td>
            {row.ports.length === 0 ? '—' : row.ports.map((p, i) => (
              <span
                key={`${p.proto}-${p.addr}-${p.port}-${i}`}
                className={p.inherited ? 'port-inherited' : undefined}
                title={[
                  p.addr === 'localhost' || isLoopback(p.addr) ? null : `bound to ${p.addr}`,
                  p.inherited ? 'inherited from a descendant process' : null,
                  p.is_http === false ? 'not an HTTP server' : null,
                  p.is_http === null || p.is_http === undefined ? 'probing…' : null,
                ].filter(Boolean).join(' · ') || undefined}
              >
                {i > 0 && ' '}
                {/* Link only when the server-side probe confirmed an
                 * HTTP response. null (not yet probed) and false render
                 * as plain text so we never link a port that won't open. */}
                {p.is_http === true ? (
                  <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer">:{p.port}</a>
                ) : (
                  <span>:{p.port}</span>
                )}
              </span>
            ))}
          </td>
        )}
        <td>
          {row.session_id ? (
            <span
              className="session-chip-wrap"
              style={(() => {
                const bg = sessionChipBackground(panel, projectColor ?? null);
                return bg ? ({ ['--session-chip-bg' as string]: bg } as CSSProperties) : {};
              })()}
            >
              <CopyableId id={row.session_id} length={8} />
            </span>
          ) : (
            // Project-only attribution (no specific session) shows in the
            // adjacent Project column, so this cell can stay empty.
            '—'
          )}
        </td>
        {now !== null && (() => {
          const idleSec = panel ? Math.max(0, now - panel.last_event_at) : null;
          // 0 = fresh, 6 = ancient. Bumps at 5m, 30m, 2h, 6h, 24h, 7d.
          // CSS picks the per-bucket color (full --fg → progressively
          // darker via color-mix).
          const bucket =
            idleSec === null ? null :
            idleSec < 300 ? 0 :
            idleSec < 1800 ? 1 :
            idleSec < 7200 ? 2 :
            idleSec < 21600 ? 3 :
            idleSec < 86400 ? 4 :
            idleSec < 604800 ? 5 :
            6;
          return (
            <td
              className={bucket !== null ? `process-idle idle-bucket-${bucket}` : 'process-idle'}
              title={panel ? 'time since last event in this session' : 'no session activity tracked'}
            >
              {idleSec === null ? '—' : formatIdle(idleSec)}
            </td>
          );
        })()}
        <td>{fmtUptime(row.uptime_s)}</td>
        <td>
          {/* Tail-stdout toggle (▾) is hidden until the logs UX is
           * redesigned — inline <pre> below the row was too disruptive.
           * Kill action remains. */}
          <button onClick={kill} aria-label={`Kill PID ${row.pid}`}>✕</button>
        </td>
      </tr>
    </>
  );
}
