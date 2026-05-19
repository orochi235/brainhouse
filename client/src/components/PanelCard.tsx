import classNames from 'classnames';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { formatIdle, formatIdleCoarse } from '../lib/format.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import { type ChecklistItem, preprocessEvents } from '../lib/pipeline.ts';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';
import { EventList } from './EventList.tsx';

interface Props {
  panel: PanelState;
  /** True when this panel is nested inside another panel's subagent tray. */
  nested?: boolean;
}

/**
 * One panel — header + (optional) pinned checklist + scrolling event body.
 *
 * The thinking indicator, waiting glow, and idle counter are all derived
 * from a useMemo over panel.events, plus a 1Hz tick for the time displays.
 */
export function PanelCard({ panel, nested }: Props) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const { items, checklist, pending } = useMemo(
    () => preprocessEvents(panel.events),
    [panel.events],
  );
  const waiting = pending && panel.status === 'live';
  const progressPct = checklist ? progressPercent(checklist) : null;

  const style: CSSProperties = {};
  if (progressPct !== null) (style as Record<string, string>)['--progress'] = `${progressPct}%`;

  return (
    <article
      className={classNames(
        'panel',
        `panel-${panel.kind}`,
        `status-${panel.status}`,
        waiting && 'waiting',
        progressPct !== null && 'has-progress',
        nested && 'nested',
      )}
      data-panel-id={panel.id}
      style={style}
    >
      <PanelHeader panel={panel} now={now} />
      {checklist && <ChecklistPin items={checklist} />}
      <div className="panel-body">
        <EventList events={panel.events} />
        {waiting && <ThinkingIndicator started={lastUserActivity(items, now)} now={now} />}
      </div>
    </article>
  );
}

function PanelHeader({ panel, now }: { panel: PanelState; now: number }) {
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
          lightbox.open(<PanelLightboxContent panel={panel} />);
        }
      }}
    >
      <span className="panel-title">{panel.title}</span>
      <span className="panel-meta">
        <span className="panel-idle">{idleLabel}</span>
        {isLive && <span className="panel-status live">live</span>}
        <HeaderActions panel={panel} />
      </span>
    </header>
  );
}

function HeaderActions({ panel }: { panel: PanelState }) {
  if (panel.status === 'live') {
    return (
      <button
        type="button"
        className="panel-btn"
        title="Force this session to done"
        onClick={(e) => {
          e.stopPropagation();
          trpc.forceStatus.mutate({ panelId: panel.id, status: 'done' });
        }}
      >
        ×
      </button>
    );
  }
  if (panel.status === 'mini') {
    return (
      <button
        type="button"
        className="panel-btn panel-trash"
        title="Delete this session permanently"
        onClick={(e) => {
          e.stopPropagation();
          trpc.remove.mutate({ panelId: panel.id });
        }}
      >
        🗑
      </button>
    );
  }
  // done — no per-panel buttons; click anywhere opens lightbox.
  return null;
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
      <h3 className="lightbox-title">{panel.title}</h3>
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
