/**
 * Outer modal shell for the pipeline inspector. The body is owned by
 * `<TransformsInspector />` (Spec 2: types + transforms browse; Spec 3:
 * live trace). Modal/lightbox/hotkey machinery is unchanged.
 */

import { TransformsInspector } from './transforms-inspector/TransformsInspector.tsx';

export function TransformsModal() {
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline inspector</h3>
      <TransformsInspector />
    </div>
  );
}
