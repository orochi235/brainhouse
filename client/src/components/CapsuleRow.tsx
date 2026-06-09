/**
 * Shared base for conversation-row "capsules" — the `<li>` that wraps a
 * tool capsule, file-change row, system/meta line, terminal block, or
 * chat bubble. Centralizes:
 *
 *   - The `event event-${kind}` class scheme.
 *   - The trailing slot (`.event-trailer`) where the timestamp lives,
 *     plus an optional status node that sits immediately to the left
 *     of the time.
 *   - The click handler hook.
 *
 * Anything you want the timestamp positioned correctly on should use
 * this base; otherwise we end up re-inventing absolute-positioning
 * rules per row and the timestamp keeps drifting whenever a row's
 * inner layout changes. OpStripRow is the one row that intentionally
 * uses inline flex layout for its trailer and stays outside this
 * base — every other capsule funnels through here.
 */
import classNames from 'classnames';
import type { ReactNode } from 'react';
import { EventTime } from './EventList.tsx';

interface Props {
  /** Suffix for the `event-${kind}` class. Drives per-row CSS. */
  kind: string;
  /** ISO timestamp shown in the trailing slot. */
  ts?: string;
  /** For the body.show-elapsed mode — passed straight to EventTime. */
  startedAt?: number;
  /** Extra class names on the `<li>` (e.g. `'canceled'`, status modifiers). */
  className?: string;
  /** Optional node placed inside the trailer, immediately left of the
   * time (typically a status glyph or check/error mark). */
  trailing?: ReactNode;
  /** Suppress the trailing time slot entirely. Used by rows that have no
   * meaningful timestamp (dividers). Most rows leave this false. */
  hideTime?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}

export function CapsuleRow({
  kind,
  ts,
  startedAt,
  className,
  trailing,
  hideTime,
  onClick,
  children,
}: Props) {
  return (
    <li className={classNames('event', `event-${kind}`, className)} onClick={onClick}>
      {children}
      {!hideTime && ts !== undefined && (
        <span className="event-trailer">
          {trailing}
          <EventTime ts={ts} startedAt={startedAt} />
        </span>
      )}
    </li>
  );
}
