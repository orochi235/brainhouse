import type { Event } from '@server/parser.ts';
import classNames from 'classnames';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { formatIdle, formatIdleCoarse } from '../lib/format.ts';
import { renderInlineCode } from '../lib/inlineCode.tsx';
import { useLightbox } from '../lib/lightbox.tsx';
import { type ChecklistItem, preprocessEvents } from '../lib/pipeline.ts';
import { projectLabel } from '../lib/project.ts';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';
import { EventList } from './EventList.tsx';

interface Props {
  panel: PanelState;
  /** True when this panel is nested inside another panel's subagent tray. */
  nested?: boolean;
  /** Close this panel's window. The underlying session is untouched — the
   * panel will pop back into view as soon as new activity arrives. */
  onHide?: () => void;
  /** Restore from the tray back to the grid. Provided only by tray renderers;
   * its presence suppresses the `×` button (a panel already in the tray
   * doesn't need a close affordance, but does need an unmini). */
  onRestore?: () => void;
  /** Pinned panels stay in the grid + don't dim regardless of status/age. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Account label to badge in the header. Parent typically passes
   * `panel.account_label` when more than one account is configured;
   * undefined/null suppresses the badge. */
  account?: string | null;
}

/**
 * One panel — header + (optional) pinned checklist + scrolling event body.
 *
 * The thinking indicator, waiting glow, and idle counter are all derived
 * from a useMemo over panel.events, plus a 1Hz tick for the time displays.
 */
export function PanelCard({
  panel,
  nested,
  onHide,
  onRestore,
  pinned,
  onTogglePin,
  account,
}: Props) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const lightbox = useLightbox();
  const articleRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastStatusRef = useRef(panel.status);
  const [collapsed, setCollapsed] = useState(false);
  const prevProgressRef = useRef<number | null>(null);
  // True until the user scrolls away from the bottom. Re-armed when they
  // scroll back. While true, new events keep the view pinned at the bottom.
  const stickToBottomRef = useRef(true);

  // On mount and whenever the panel id changes (e.g. focused view), jump
  // straight to the bottom — "restoring a session view almost always wants
  // the latest activity, not the top of the transcript."
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel.id drives the reset; refs are intentionally not deps.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [panel.id]);

  // When new events arrive, keep the view pinned at the bottom *only* if
  // the user hadn't scrolled up to read history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events.length is the trigger; refs read inside intentionally.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [panel.events.length]);

  // Completion sweep: fire briefly on live → done transitions.
  useEffect(() => {
    if (lastStatusRef.current === 'live' && panel.status === 'done' && articleRef.current) {
      const el = articleRef.current;
      el.classList.add('completing');
      const t = setTimeout(() => el.classList.remove('completing'), 800);
      return () => clearTimeout(t);
    }
    lastStatusRef.current = panel.status;
  }, [panel.status]);

  const { items, checklist, pending } = useMemo(
    () => preprocessEvents(panel.events),
    [panel.events],
  );
  const waiting = pending && panel.status === 'live';
  const progressPct = checklist ? progressPercent(checklist) : null;

  // Subagent at 100% progress: play a collapse animation, then unmount.
  // Parent panels are never auto-collapsed; their lifecycle stays
  // server-driven (idle → done → mini → removed).
  useEffect(() => {
    const prev = prevProgressRef.current;
    prevProgressRef.current = progressPct;
    if (panel.kind !== 'subagent') return;
    if (progressPct !== 100 || prev === 100) return;
    const article = articleRef.current;
    if (!article) return;
    article.classList.add('progress-completing');
    const t = setTimeout(() => setCollapsed(true), 950);
    return () => clearTimeout(t);
  }, [progressPct, panel.kind]);

  if (collapsed) return null;

  const onBubbleClick = (event: Event) => {
    // Open the full turn that contains this bubble. If for some reason we
    // can't resolve a turn (e.g. event.uuid not found in events), fall back
    // to showing the single message — clicking should never appear to do
    // nothing.
    const turn = computeTurn(panel.events, event.uuid);
    const eventsToShow = turn.length > 0 ? turn : [event];
    lightbox.open(<TurnLightbox panel={panel} events={eventsToShow} />, {
      theme: panel.theme,
    });
  };

  const style: CSSProperties = {};
  const styleVars = style as Record<string, string>;
  if (progressPct !== null) styleVars['--progress'] = `${progressPct}%`;
  if (panel.theme) {
    styleVars['--panel-theme-bg'] = panel.theme.background;
    styleVars['--panel-theme-fg'] = panel.theme.foreground;
  }

  return (
    <article
      ref={articleRef}
      className={classNames(
        'panel',
        `panel-${panel.kind}`,
        `status-${panel.status}`,
        waiting && 'waiting',
        progressPct !== null && 'has-progress',
        panel.theme && 'has-theme',
        nested && 'nested',
        pinned && 'pinned',
        panel.removing && 'removing',
      )}
      data-panel-id={panel.id}
      style={style}
    >
      <PanelHeader
        panel={panel}
        now={now}
        onHide={onHide}
        onRestore={onRestore}
        pinned={pinned}
        onTogglePin={onTogglePin}
        account={account}
      />
      {checklist && <ChecklistPin items={checklist} />}
      <div
        className="panel-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // 32px slack so a near-bottom scroll still counts as "at bottom".
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        <EventList
          events={panel.events}
          startedAt={panel.started_at}
          onBubbleClick={onBubbleClick}
        />
        {waiting && <ThinkingIndicator started={lastUserActivity(items, now)} now={now} />}
        {panel.status !== 'live' && (
          <div className="session-ended" aria-label="session ended">
            <span>session ended</span>
          </div>
        )}
      </div>
    </article>
  );
}

function TurnLightbox({ panel, events }: { panel: PanelState; events: Event[] }) {
  return (
    <>
      <h3 className="lightbox-title">{renderInlineCode(panel.title)}</h3>
      <EventList events={events} startedAt={panel.started_at} />
    </>
  );
}

function computeTurn(events: Event[], anchorUuid: string): Event[] {
  const anchorIdx = events.findIndex((e) => e.uuid === anchorUuid);
  if (anchorIdx === -1) return [];
  let start = 0;
  for (let i = anchorIdx; i >= 0; i--) {
    if (events[i]?.kind === 'user_text') {
      start = i;
      break;
    }
  }
  let end = events.length;
  for (let i = start + 1; i < events.length; i++) {
    if (events[i]?.kind === 'user_text') {
      end = i;
      break;
    }
  }
  return events.slice(start, end);
}

function PanelHeader({
  panel,
  now,
  onHide,
  onRestore,
  pinned,
  onTogglePin,
  account,
}: {
  panel: PanelState;
  now: number;
  onHide?: () => void;
  onRestore?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  account?: string | null;
}) {
  const lightbox = useLightbox();
  const isLive = panel.status === 'live';
  let idleLabel: string;
  if (isLive) {
    idleLabel = formatIdle(Math.max(0, now - panel.last_event_at));
  } else if (panel.status === 'mini') {
    idleLabel = `${formatIdleCoarse(Math.max(0, now - panel.status_changed_at))} ago`;
  } else {
    idleLabel = `${panel.status} ${formatIdleCoarse(Math.max(0, now - panel.status_changed_at))} ago`;
  }

  return (
    <header
      className="panel-header"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        if (panel.status !== 'live') {
          // Open the whole panel in a lightbox so done/mini panels can still be inspected.
          lightbox.open(<PanelLightboxContent panel={panel} />, { theme: panel.theme });
        }
      }}
    >
      {onRestore ? (
        <button
          type="button"
          className="panel-pin panel-restore"
          title="Restore to the grid"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
        >
          ↖
        </button>
      ) : (
        onTogglePin && (
          <button
            type="button"
            className={classNames('panel-pin', pinned && 'pinned')}
            title={
              pinned
                ? 'Unpin (let this session age normally)'
                : 'Pin (keep visible regardless of age)'
            }
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
          >
            {pinned ? '📍' : '📌'}
          </button>
        )
      )}
      <span className="panel-titles">
        <span className="panel-title">{renderInlineCode(panel.title)}</span>
        <span className="panel-subtitle-row">
          {panel.kind === 'subagent' && panel.agent_type ? (
            <span className="panel-subtitle">{panel.agent_type}</span>
          ) : panel.cwd ? (
            <span className="panel-subtitle">{projectLabel(panel.cwd)}</span>
          ) : null}
          {account && (
            <span className="panel-account" title={`account: ${account}`}>
              {account}
            </span>
          )}
          {panel.status === 'mini' && <span className="panel-idle-inline">{idleLabel}</span>}
        </span>
      </span>
      <span className="panel-meta">
        {panel.status !== 'mini' && <span className="panel-idle">{idleLabel}</span>}
        {isLive && <span className="panel-status live">live</span>}
        <HeaderActions panel={panel} onHide={onHide} onRestore={onRestore} />
      </span>
    </header>
  );
}

function HeaderActions({
  panel,
  onHide,
  onRestore,
}: {
  panel: PanelState;
  onHide?: () => void;
  onRestore?: () => void;
}) {
  const isLive = panel.status === 'live';
  // When the panel lives in the tray (onRestore provided), we swap `×` for
  // a restore affordance. A tray panel doesn't need closing — it's already
  // out of the way — but it does need an unmini.
  const inTray = !!onRestore;
  return (
    <>
      {isLive && panel.kind === 'subagent' && (
        <button
          type="button"
          className="panel-btn panel-btn-faint"
          title="Open this subagent in its own window"
          onClick={(e) => {
            e.stopPropagation();
            window.open(
              `/?panel=${encodeURIComponent(panel.id)}`,
              `brainhouse-${panel.id}`,
              'width=900,height=900',
            );
          }}
        >
          ⤢
        </button>
      )}
      {isLive && (
        <button
          type="button"
          className="panel-btn panel-btn-faint"
          title="Full-screen (Esc to close)"
          onClick={(e) => {
            e.stopPropagation();
            const article = (e.currentTarget.closest('.panel') as HTMLElement) ?? null;
            if (article) {
              const on = article.classList.toggle('fullscreen');
              document.body.classList.toggle('has-fullscreen-panel', on);
            }
          }}
        >
          ⛶
        </button>
      )}
      {panel.status === 'mini' && (
        <button
          type="button"
          className="panel-btn panel-trash"
          title="Move to trash (reversible from prefs → Trash)"
          onClick={(e) => {
            e.stopPropagation();
            trpc.remove.mutate({ panelId: panel.id });
          }}
        >
          🗑
        </button>
      )}
      {!inTray && onHide && (
        <button
          type="button"
          className="panel-btn"
          title="Close this window. The session keeps running; this panel reappears on new activity."
          onClick={(e) => {
            e.stopPropagation();
            onHide();
          }}
        >
          ×
        </button>
      )}
    </>
  );
}

function ChecklistPin({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <div className="panel-pinned">
      <div className="checklist-summary">
        progress · {done} / {items.length}
      </div>
      <ul className="checklist">
        {items.map((it, i) => (
          <li key={`${i}-${it.text}`} className={it.done ? 'done' : undefined}>
            <span className={classNames('check', it.done && 'done')}>{it.done ? '✓' : '○'}</span>
            <span className="label">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThinkingIndicator({ started, now }: { started: number; now: number }) {
  const dt = Math.max(0, now - started);
  return (
    <div className="thinking-indicator">
      <span className="thinking-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-timer">{formatIdle(dt)}</span>
    </div>
  );
}

function PanelLightboxContent({ panel }: { panel: PanelState }) {
  return (
    <>
      <h3 className="lightbox-title">{renderInlineCode(panel.title)}</h3>
      <EventList events={panel.events} />
    </>
  );
}

function progressPercent(items: ChecklistItem[]): number {
  if (items.length === 0) return 0;
  return Math.round((items.filter((i) => i.done).length / items.length) * 100);
}

/**
 * Best-effort: time of the last user_text / tool_result; everything else
 * (asst text, tool_use) clears the pending state so the indicator goes away.
 */
function lastUserActivity(
  items: ReturnType<typeof preprocessEvents>['items'],
  fallback: number,
): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type === 'bubble' && item.role === 'user') return parseTs(item.event.ts, fallback);
    if (item.type === 'tool' && item.result) return fallback; // result.ts not stored; use fallback
  }
  return fallback;
}

function parseTs(ts: string, fallback: number): number {
  if (!ts) return fallback;
  const t = new Date(ts).getTime() / 1000;
  return Number.isNaN(t) ? fallback : t;
}
