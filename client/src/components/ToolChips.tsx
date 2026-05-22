/**
 * Pill-shaped chip bar of compact action buttons. The inverted-color row
 * floats over panel content (panel hover toolbar) and lightbox headers
 * (e.g. view-mode toggles). Visually neutral — positioning and reveal
 * behavior belong to the parent.
 */
import classNames from 'classnames';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function ToolChips({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'children' | 'className'
>) {
  return (
    <div className={classNames('tool-chips', className)} {...rest}>
      {children}
    </div>
  );
}

export function ToolChip({
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={classNames('tool-chip', className)} {...rest}>
      {children}
    </button>
  );
}
