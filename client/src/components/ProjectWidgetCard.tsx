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
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  aggregateProjectStatus,
  type ProjectRollup,
  type ProjectRollupSessionRow,
} from '../lib/projectWidgets.ts';
import { trpc } from '../trpc.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import { worktreeColor } from '../lib/worktree.ts';
import { BlacklistConfirm } from './BlacklistConfirm.tsx';
import { StatusLight } from './StatusLight.tsx';
import { TitleBar } from './TitleBar.tsx';

export function ProjectWidgetCard({
  rollup,
  onOpenSession,
  pinned,
  onTogglePin,
  onClose,
  accountColor,
}: {
  rollup: ProjectRollup;
  onOpenSession?: (sessionId: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
  accountColor?: string;
}) {
  const { widget, theme, account_label, fileCount, totalTokens, recentSessions } = rollup;
  // The in-memory `recentSessions` covers only currently-tracked panels
  // (live/done/mini). Older sessions get reaped after their mini window
  // expires, so a project with a long history would otherwise show just
  // 1–2 entries. Pull the historical list from the server's persistent
  // `session_summary` table and merge — live rows win on collision so
  // their status stays accurate. Best-effort: if the query fails, fall
  // back to the in-memory list.
  const { sessions: mergedSessions, totalCount } = useMergedProjectSessions(
    widget.cwd,
    recentSessions,
  );

  const styleVars: CSSProperties & Record<string, string> = {
    ['--panel-worktree-color']: worktreeColor(widget.repo),
  };
  if (theme) {
    styleVars['--panel-theme-bg'] = theme.background;
    styleVars['--panel-theme-fg'] = theme.foreground;
  }
  if (accountColor) {
    styleVars['--account-color'] = accountColor;
  }

  const agg = aggregateProjectStatus(rollup);

  // Compose the leading column: status light on top, optional close
  // below. CSS gives the column a rotated-T border so the two sit in
  // visually-distinct cells.
  const leading = (
    <>
      <StatusLight
        title={`${rollup.widget.repo} — ${agg.status}${
          agg.ended ? ' · all ended' : agg.awaitingInput ? ' · awaiting input' : ''
        }${pinned ? ' · pinned' : ''}${onTogglePin ? ' · click to toggle pin' : ''}`}
        ended={agg.ended}
        pinned={pinned}
        ariaPressed={onTogglePin ? !!pinned : undefined}
        onClick={
          onTogglePin
            ? (e) => {
                e.stopPropagation();
                onTogglePin();
              }
            : undefined
        }
      />
      {onClose && (
        <ProjectWidgetCloseButton
          rollup={rollup}
          mergedSessions={mergedSessions}
          onClose={onClose}
        />
      )}
    </>
  );

  return (
    <article
      className={classNames(
        'panel project-widget',
        `status-${agg.status}`,
        agg.ended && 'ended',
        agg.awaitingInput && 'awaiting-input',
        theme && 'has-theme',
      )}
      style={styleVars}
    >
      <TitleBar
        className="project-widget-header"
        leading={leading}
        title={<span className="project-widget-title">{widget.repo}</span>}
        titleAside={<span className="project-widget-kind">project</span>}
        subtitleLeading={
          account_label ? (
            <span className="panel-account" title={`account: ${account_label}`}>
              {account_label}
            </span>
          ) : undefined
        }
        subtitle={
          <span className="project-widget-path" title={widget.cwd}>
            {widget.cwd}
          </span>
        }
      />
      <div className="project-widget-stats">
        <Stat label="sessions" value={totalCount} />
        <Stat label="files" value={fileCount} />
        <Stat label="tokens" value={formatTokens(totalTokens)} />
      </div>
      <ul className="project-widget-sessions">
        {mergedSessions.length === 0 && (
          <li className="project-widget-sessions-empty">no sessions loaded</li>
        )}
        {mergedSessions.map((s) => (
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

/** Merge the in-memory recent-sessions list with the persistent
 * `session_summary` table for this project's root. Live entries win on
 * id collision so their live status (awaiting input, ended, etc.) keeps
 * displaying correctly; historical rows fill in everything older that
 * has aged out of the in-memory map. */
function useMergedProjectSessions(
  root: string,
  liveRows: ProjectRollupSessionRow[],
): { sessions: ProjectRollupSessionRow[]; totalCount: number } {
  const [historical, setHistorical] = useState<ProjectRollupSessionRow[]>([]);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    trpc.sessions.forProject
      .query({ root, limit: 200, parentOnly: true })
      .then((data) => {
        if (cancelled) return;
        const rows: ProjectRollupSessionRow[] = data.sessions.map((s) => ({
          id: s.session_id,
          title: s.title ?? '',
          // Historical rows are no longer in the live lifecycle. Render
          // them as `done` so the dot styling stays consistent; the
          // ended flag below dims them so users can tell at a glance.
          status: 'done',
          last_event_at: s.ended_at,
          started_at: s.started_at,
          awaiting_input: false,
          ended: true,
          // session_summary doesn't store token totals — historical
          // rows contribute 0 to the per-row chip. The widget-level
          // token stat still comes from in-memory panels only (noted
          // there).
          tokens: 0,
        }));
        setHistorical(rows);
      })
      .catch(() => {
        // Server-down / persistence-off: leave historical empty and let
        // the live-only list render. The widget keeps working.
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  return useMemo(() => {
    const byId = new Map<string, ProjectRollupSessionRow>();
    for (const h of historical) byId.set(h.id, h);
    for (const l of liveRows) byId.set(l.id, l); // live wins
    const sessions = Array.from(byId.values()).sort(
      (a, b) => b.last_event_at - a.last_event_at,
    );
    return { sessions, totalCount: sessions.length };
  }, [historical, liveRows]);
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

function ProjectWidgetCloseButton({
  rollup,
  mergedSessions,
  onClose,
}: {
  rollup: ProjectRollup;
  mergedSessions: ProjectRollupSessionRow[];
  onClose: () => void;
}) {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className="project-widget-action project-widget-action-close"
      title="Hide this project widget. Shift-click to blacklist every session in this project."
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          const ids = mergedSessions.map((s) => s.id).filter(Boolean);
          if (ids.length === 0) {
            onClose();
            return;
          }
          lightbox.open(
            <BlacklistConfirm label={rollup.widget.repo} sessionIds={ids} />,
          );
          return;
        }
        onClose();
      }}
    >
      ×
    </button>
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
