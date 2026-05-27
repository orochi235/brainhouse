/**
 * Insert a "day divider" between two consecutive items whose timestamps
 * fall on different local-calendar days. Mirrors the `session-ended`
 * terminator visually so a long-running session reads as a small
 * journal: each day's activity sits under its own date heading.
 *
 * Runs last (after coalesceBetweenChats), so dividers sit at the
 * top level of the assembled list — not buried inside an op-strip.
 *
 * "Only if there's been activity that day" falls out naturally: we
 * insert only *between* items, never on a calendar tick, so a fully
 * idle day produces nothing. Two dividers can never land adjacent
 * either — each one is anchored to a real item that follows it.
 */

import type { ViewItem } from '../../lib/pipeline-types.ts';
import type { Stage2Transform } from '../types.ts';

export const insertDayDividers: Stage2Transform = {
  kind: 'view',
  stage: 2,
  key: 'built-in.insert-day-dividers',
  name: 'insertDayDividers',
  description:
    'Inserts a date heading (styled like the session-ended terminator) between two items that fall on different local-calendar days.',
  run(items) {
    const out: ViewItem[] = [];
    let prevDate: string | null = null;
    for (const item of items) {
      const ts = itemTs(item);
      const date = ts ? localDateKey(ts) : null;
      if (date && prevDate && date !== prevDate) {
        out.push({
          type: 'day-divider',
          ts,
          date,
          label: formatDayLabel(ts),
          anchorUuid: itemAnchor(item),
        });
      }
      if (date) prevDate = date;
      out.push(item);
    }
    return out;
  },
};

function itemTs(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.ts;
  }
  if (item.type === 'bubble') return item.event.ts;
  if (item.type === 'interrupt-divider' || item.type === 'day-divider') return item.ts;
  return item.event.ts;
}

function itemAnchor(item: ViewItem): string {
  if (item.type === 'tool' || item.type === 'file-change' || item.type === 'op-strip') {
    return item.anchorUuid;
  }
  if (item.type === 'bubble') return item.event.uuid;
  if (item.type === 'interrupt-divider' || item.type === 'day-divider') return item.anchorUuid;
  return item.event.uuid;
}

/** Stable key for the local calendar day — used only for equality
 * comparisons against the previous item, not for display. Format is
 * `YYYY-MM-DD` in the browser's local timezone. */
function localDateKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Human label for the divider, e.g. "Tuesday, May 27, 2026". Browser
 * locale; current-year omitted to keep the line short when most of a
 * session's days are recent. */
function formatDayLabel(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}
