/**
 * Project-widget card. Same outer dimensions as a session `PanelCard`.
 *
 * Layout:
 *   ┌───────────────────────────────┐
 *   │ <repo>            account  │  ← header
 *   │ <cwd>                        │  ← project filesystem path
 *   ├───────────────────────────────┤
 *   │ N sessions · M files · T tok │  ← stat strip
 *   ├───────────────────────────────┤
 *   │ recent sessions               │  ← scrollable list
 *   │   • title           5m ago    │
 *   │   • title         12m ago    │
 *   └───────────────────────────────┘
 *
 * Color: `.hued` theme stamped on the most-recent panel for the project,
 * piped through `--panel-theme-bg` / `--panel-theme-fg` like a session
 * panel. Falls back to a deterministic hash color when no `.hued` exists.
 */

import classNames from 'classnames';
import { type CSSProperties } from 'react';
import type { ProjectRollup, ProjectRollupSessionRow } from '../lib/projectWidgets.ts';
import { worktreeColor } from '../lib/worktree.ts';

export function ProjectWidgetCard({
  rollup,
  onOpenSession,
}: {
  rollup: ProjectRollup;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { widget, theme, account_label, sessionCount, fileCount, totalTokens, recentSessions } =
    rollup;

  const styleVars: CSSProperties & Record<string, string> = {
    ['--panel-worktree-color']: worktreeColor(widget.repo),
  };
  if (theme) {
    styleVars['--panel-theme-bg'] = theme.background;
    styleVars['--panel-theme-fg'] = theme.foreground;
  }

  return (
    <article
      className={classNames('panel project-widget', theme && 'has-theme')}
      style={styleVars}
    >
      <header className="panel-header project-widget-header">
        <div className="project-widget-header-row">
          <span className="project-widget-title">{widget.repo}</span>
          <span className="project-widget-kind">project</span>
        </div>
        <div className="project-widget-meta-row">
          <span className="project-widget-path" title={widget.cwd}>
            {widget.cwd}
          </span>
          {account_label && (
            <span className="project-widget-account">{account_label}</span>
          )}
        </div>
      </header>
      <div className="project-widget-stats">
        <Stat label="sessions" value={sessionCount} />
        <Stat label="files" value={fileCount} />
        <Stat label="tokens" value={formatTokens(totalTokens)} />
      </div>
      <ul className="project-widget-sessions">
        {recentSessions.length === 0 && (
          <li className="project-widget-sessions-empty">no sessions loaded</li>
        )}
        {recentSessions.map((s) => (
          <SessionRow key={s.id} row={s} onOpen={onOpenSession} />
        ))}
      </ul>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="project-widget-stat">
      <span className="project-widget-stat-value">{value}</span>
      <span className="project-widget-stat-label">{label}</span>
    </div>
  );
}

function SessionRow({
  row,
  onOpen,
}: {
  row: ProjectRollupSessionRow;
  onOpen?: (id: string) => void;
}) {
  const ageLabel = formatAge(Date.now() / 1000 - row.last_event_at);
  return (
    <li>
      <button
        type="button"
        className={classNames(
          'project-widget-session-row',
          `status-${row.status}`,
          row.awaiting_input && 'awaiting',
          row.ended && 'ended',
        )}
        onClick={() => onOpen?.(row.id)}
        title={`${row.title}\nlast active ${ageLabel}`}
      >
        <span className={classNames('project-widget-session-dot', `status-${row.status}`)} />
        <span className="project-widget-session-title">{row.title || '(untitled)'}</span>
        <span className="project-widget-session-age">{ageLabel}</span>
      </button>
    </li>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
