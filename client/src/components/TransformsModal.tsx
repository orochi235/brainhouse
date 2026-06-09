/**
 * Outer modal shell for the pipeline inspector. The body is owned by
 * `<TransformsInspector />` (Spec 2: types + transforms browse;
 * Spec 3: live trace, surfaced when opened with panel context).
 * Modal/lightbox/hotkey machinery is unchanged.
 */

import type { Event } from '@server/parser.ts';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { TransformsInspector } from './transforms-inspector/TransformsInspector.tsx';

interface TransformsModalProps {
  panelId?: string;
  events?: Event[];
  items?: ViewItem[];
}

export function TransformsModal({ panelId, events, items }: TransformsModalProps = {}) {
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline inspector</h3>
      <TransformsInspector panelId={panelId} events={events} items={items} />
    </div>
  );
}
