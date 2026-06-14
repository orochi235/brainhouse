import type { Event } from '@server/parser.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { renderInlineCode } from '../lib/inlineCode.tsx';
import type { PanelState } from '../useDeltaStream.ts';
import { trpc } from '../trpc.ts';
import { TruncationTooltip } from './HoverPopover.tsx';
import { EventList } from './EventList.tsx';

/** Lightbox content for a threaded-reply jump. Renders the panel's events
 * (backfilling the target on demand when it's outside the live window) and
 * scrolls + pulses the target once it's present. */
export function ThreadedReplyLightbox({
  panel,
  refUuid,
}: {
  panel: PanelState;
  refUuid: string;
}) {
  const [extra, setExtra] = useState<Event | null>(null);
  const inWindow = useMemo(() => panel.events.some((e) => e.uuid === refUuid), [panel.events, refUuid]);

  useEffect(() => {
    if (inWindow) return;
    let alive = true;
    trpc.eventByUuid.query({ panelId: panel.id, uuid: refUuid }).then((res) => {
      if (alive && res.event) setExtra(res.event as Event);
    });
    return () => {
      alive = false;
    };
  }, [inWindow, panel.id, refUuid]);

  const events = useMemo<Event[]>(() => {
    if (inWindow || !extra) return panel.events;
    const merged = [...panel.events, extra];
    merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return merged;
  }, [inWindow, extra, panel.events]);

  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current) return;
    if (!events.some((e) => e.uuid === refUuid)) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-anchor-uuid="${CSS.escape(refUuid)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('focus-pulse');
      window.setTimeout(() => el.classList.remove('focus-pulse'), 900);
      scrolled.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [events, refUuid]);

  return (
    <>
      <TruncationTooltip text={panel.title}>
        <h3 className="lightbox-title">
          {panel.manually_renamed && (
            <span
              className="panel-title-manual-glyph"
              aria-label="title set manually via /rename"
              title="Title set manually via /rename"
            >
              ❖
            </span>
          )}
          {renderInlineCode(panel.title)}
        </h3>
      </TruncationTooltip>
      <EventList events={events} cwd={panel.cwd} />
    </>
  );
}
