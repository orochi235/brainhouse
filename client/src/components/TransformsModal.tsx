/**
 * Debug view of the event → view-item transforms. Reads directly from
 * the registry in `../transforms/registry.ts`, so adding a transform
 * shows up here for free.
 */

import { VIEW_TRANSFORMS } from '../transforms/registry.ts';

export function TransformsModal() {
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline transforms</h3>
      <p className="transforms-intro">
        Event → view-item transforms applied by <code>preprocessEvents()</code>. Stage 1 walks the
        event list and emits view items; stage 2 reshapes them.
      </p>
      <ol className="transforms-list">
        {VIEW_TRANSFORMS.map((t) => (
          <li className={`transforms-item transforms-pass-${t.stage}`} key={t.key}>
            <div className="transforms-row">
              <span className="transforms-name">{t.name}</span>
              <span className="transforms-stage">{`stage ${t.stage}`}</span>
            </div>
            <div className="transforms-source">{t.key}</div>
            <p className="transforms-blurb">{t.description}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
