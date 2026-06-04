/**
 * Slotted title-bar layout shared by `PanelCard` (session) and
 * `ProjectWidgetCard` (project). Pure layout — no panel/rollup/session
 * concepts. Callers compose status lights, chips, action buttons, etc.
 * into the slots; CSS in `app.css` (`.title-bar*`) does the geometry.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [leading]   <title> <titleAside…>           [trailing…]     │
 *   │             <subtitle> <subtitleAside…>                     │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * - `leading` is a vertically-stacking column (status light, action
 *   buttons, etc.). Callers control its internal layout.
 * - The body holds two rows (`title` + `subtitle`), each with an
 *   optional aside running to the right.
 * - `trailing` is an optional right-edge column for meta info / action
 *   stacks (used by session panels for tokens/time/context).
 */

import classNames from 'classnames';
import type { MouseEvent, ReactNode } from 'react';

export type TitleBarProps = {
  leading?: ReactNode;
  title: ReactNode;
  /** Inline content rendered to the right of the title text but still
   * in the row's left half (e.g. an account badge that should sit
   * adjacent to the project name without joining the far-right aside
   * group). */
  titleTrailing?: ReactNode;
  titleAside?: ReactNode;
  subtitle?: ReactNode;
  /** Inline content rendered to the right of the subtitle text but
   * still in the row's left half. */
  subtitleTrailing?: ReactNode;
  subtitleAside?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
};

export function TitleBar({
  leading,
  title,
  titleTrailing,
  titleAside,
  subtitle,
  subtitleTrailing,
  subtitleAside,
  trailing,
  className,
  onClick,
}: TitleBarProps) {
  return (
    <header className={classNames('title-bar', className)} onClick={onClick}>
      {leading !== undefined && <div className="title-bar-leading">{leading}</div>}
      <div className="title-bar-body">
        <div className="title-bar-title-row">
          <span className="title-bar-row-left">
            <span className="title-bar-title">{title}</span>
            {titleTrailing}
          </span>
          {titleAside !== undefined && (
            <span className="title-bar-aside">{titleAside}</span>
          )}
        </div>
        {(subtitle !== undefined || subtitleAside !== undefined) && (
          <div className="title-bar-subtitle-row">
            <span className="title-bar-row-left">
              {subtitle !== undefined && (
                <span className="title-bar-subtitle">{subtitle}</span>
              )}
              {subtitleTrailing}
            </span>
            {subtitleAside !== undefined && (
              <span className="title-bar-aside">{subtitleAside}</span>
            )}
          </div>
        )}
      </div>
      {trailing !== undefined && <div className="title-bar-trailing">{trailing}</div>}
    </header>
  );
}
