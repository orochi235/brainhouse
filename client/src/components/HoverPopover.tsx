/**
 * Lightweight hover-driven popover. Anchors to a wrapped child element;
 * the `content` renders as a fixed-position floating box below the
 * anchor while the cursor sits on either the anchor OR the popover.
 *
 * No portal — relies on `position: fixed` + z-index to escape parent
 * overflow. Built to host structured HTML (tables, paragraphs) where
 * the browser `title` attribute can only show plain text.
 *
 * Positioning: below by default; flips above if it would clip the
 * viewport bottom. Horizontally clamped to stay inside the viewport.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Coords {
  left: number;
  top: number;
  placement: 'below' | 'above';
}

const SHOW_DELAY_MS = 200;
const HIDE_DELAY_MS = 100;
const GAP_PX = 6;
const VIEWPORT_PAD = 8;

export function HoverPopover({
  content,
  className,
  popoverClassName,
  children,
}: {
  content: ReactNode;
  className?: string;
  popoverClassName?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const p = popRef.current;
    if (!a) return;
    const ar = a.getBoundingClientRect();
    const pw = p?.offsetWidth ?? 280;
    const ph = p?.offsetHeight ?? 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - ar.bottom;
    const placement: Coords['placement'] = spaceBelow >= ph + GAP_PX ? 'below' : 'above';
    const top = placement === 'below' ? ar.bottom + GAP_PX : ar.top - ph - GAP_PX;
    let left = ar.left;
    if (left + pw > vw - VIEWPORT_PAD) left = vw - pw - VIEWPORT_PAD;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    setCoords({ left, top, placement });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  const clearShowTimer = () => {
    if (showTimerRef.current != null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };
  const clearHideTimer = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const onEnter = () => {
    clearHideTimer();
    if (open) return;
    clearShowTimer();
    showTimerRef.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  };
  const onLeave = () => {
    clearShowTimer();
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  };

  useEffect(
    () => () => {
      clearShowTimer();
      clearHideTimer();
    },
    [],
  );

  return (
    <span
      ref={anchorRef}
      className={className}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`hover-popover${popoverClassName ? ` ${popoverClassName}` : ''}`}
            role="tooltip"
            style={
              coords
                ? { left: coords.left, top: coords.top }
                : // Pre-measurement render: off-screen so we can size it before showing.
                  { left: -9999, top: -9999, visibility: 'hidden' }
            }
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
