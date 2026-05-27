/**
 * Lightbox host for the Timeline component. Lives at the panel level —
 * the tool-palette opens this with the panel's full event list. The
 * lightbox container provides width; Timeline grows to fill it.
 *
 * Thin wrapper on purpose so Timeline stays drop-in for other hosts
 * (an inline panel slot, a top-level cross-panel route).
 */

import type { PanelState } from '../useDeltaStream.ts';
import { Timeline } from './Timeline.tsx';

export function TimelineLightbox({ panel }: { panel: PanelState }) {
  return (
    <div className="timeline-lightbox">
      <h3 className="lightbox-title">
        Timeline
        <span className="lightbox-title-aux"> · {panel.title || panel.id.slice(0, 8)}</span>
      </h3>
      <Timeline events={panel.events} startedAt={panel.started_at} />
    </div>
  );
}
