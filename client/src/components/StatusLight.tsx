/**
 * The status indicator that sits in the leading slot of a TitleBar.
 * Pure UI — no panel / rollup / business types in the props. Callers
 * map their domain status to the canonical `status` value here.
 *
 * The look (color, halo, animation) is driven by the *parent's*
 * `.status-{live,done,mini}`, `.waiting`, `.awaiting-input`, `.ended`
 * classes (existing CSS) — so any container that wraps a StatusLight
 * needs to stamp those classes for the styling to fire. This keeps the
 * component compatible with the per-panel cascade that's already in
 * place.
 */

import classNames from 'classnames';
import type { MouseEvent, ReactNode } from 'react';

export type StatusLightProps = {
  /** Render as a button when an onClick is provided; otherwise a static span. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** When true, swap the dot for a checkmark glyph. Set by callers that
   * know the underlying entity is conclusively finished. */
  ended?: boolean;
  /** Shown as the button's `aria-pressed` value when interactive. */
  ariaPressed?: boolean;
  /** Title (native tooltip). */
  title?: string;
  /** Used to drive the pin/unpin spin animation. */
  spinDir?: 'cw' | 'ccw' | null;
  /** Pinned styling on the slot itself (separate from spin). */
  pinned?: boolean;
  /** Optional extra class for the slot wrapper. */
  className?: string;
};

export function StatusLight({
  onClick,
  ended,
  ariaPressed,
  title,
  spinDir,
  pinned,
  className,
}: StatusLightProps) {
  const inner: ReactNode = ended ? (
    <CheckGlyph />
  ) : (
    <span
      className={classNames(
        'panel-status-icon',
        spinDir === 'cw' && 'panel-status-icon-spin-cw',
        spinDir === 'ccw' && 'panel-status-icon-spin-ccw',
      )}
      aria-hidden="true"
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={classNames(
          'panel-status-slot',
          'panel-status-slot-button',
          pinned && 'pinned',
          className,
        )}
        title={title}
        aria-pressed={ariaPressed}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className={classNames('panel-status-slot', pinned && 'pinned', className)}
      title={title}
    >
      {inner}
    </span>
  );
}

function CheckGlyph() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="panel-status-check"
      aria-hidden="true"
    >
      <polyline points="4 12 10 18 20 6" />
    </svg>
  );
}
