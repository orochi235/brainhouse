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
  pinned,
  onTogglePin,
  onClose,
}: {
  rollup: ProjectRollup;
  onOpenSession?: (sessionId: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
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
        {(onTogglePin || onClose) && (
          <div className="project-widget-actions" aria-label="widget actions">
            {onTogglePin && (
              <button
                type="button"
                className={classNames(
                  'project-widget-action',
                  'project-widget-action-pin',
                  pinned && 'is-active',
                )}
                title={pinned ? 'Unpin widget' : 'Pin widget (always show as a tile)'}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
              >
                {pinned ? '📌' : '📍'}
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className="project-widget-action project-widget-action-close"
                title="Hide this project widget (returns on new activity)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="project-widget-header-body">
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

/**
 * Compact dock-strip variant — repo name + session count + theme tint.
 * Click promotes the widget into the grid (via the same pin toggle that
 * pinned widgets use).
 */
export function ProjectWidgetChip({
  rollup,
  onPromote,
}: {
  rollup: ProjectRollup;
  onPromote: () => void;
}) {
  const { widget, theme, sessionCount, account_label } = rollup;
  const styleVars: CSSProperties & Record<string, string> = {
    ['--panel-worktree-color']: worktreeColor(widget.repo),
  };
  if (theme) {
    styleVars['--panel-theme-bg'] = theme.background;
    styleVars['--panel-theme-fg'] = theme.foreground;
  }
  return (
    <button
      type="button"
      className={classNames('project-widget-chip', theme && 'has-theme')}
      style={styleVars}
      onClick={onPromote}
      title={`${widget.repo} — open as tile`}
    >
      <span className="project-widget-chip-swatch" aria-hidden="true" />
      <span className="project-widget-chip-title">{widget.repo}</span>
      <span className="project-widget-chip-count">{sessionCount}</span>
      {account_label && (
        <span className="project-widget-chip-account">{account_label}</span>
      )}
    </button>
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
