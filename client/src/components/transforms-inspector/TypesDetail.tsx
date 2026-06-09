/** Right column for the Types tab — full SelectorDef with cross-link chips. */

import type { StoredSelectorDef } from '../../transforms/selectors/store.tsx';
import type { ViewTransform } from '../../transforms/types.ts';
import { TransformKeyChip } from './chips.tsx';
import { SourceView } from './SourceView.tsx';

export function TypesDetail({
  def,
  usedBy,
  onJumpToTransform,
}: {
  def: StoredSelectorDef | null;
  usedBy: ViewTransform[];
  onJumpToTransform: (transformKey: string) => void;
}) {
  if (!def) {
    return (
      <div className="inspector-detail inspector-detail-empty">
        <p>Select a type to inspect.</p>
      </div>
    );
  }
  let prettySample = '';
  if (def.samplePayload !== undefined) {
    try {
      prettySample = JSON.stringify(def.samplePayload, null, 2);
    } catch {
      prettySample = String(def.samplePayload);
    }
  }
  return (
    <div className="inspector-detail">
      <header className="inspector-detail-header">
        <h4 className="inspector-detail-name">{def.name}</h4>
        <code className="inspector-detail-key">{def.key}</code>
        {def.origin === 'user' && <span className="inspector-badge-user">user</span>}
      </header>
      {def.description && <p className="inspector-detail-desc">{def.description}</p>}
      <section className="inspector-detail-section">
        <h5>Selector source</h5>
        <SourceView source={def.selector} />
      </section>
      <section className="inspector-detail-section">
        <h5>Sample payload</h5>
        {prettySample ? (
          <pre className="inspector-sample">{prettySample}</pre>
        ) : (
          <p className="inspector-muted">(no sample payload — attach one in point-and-build)</p>
        )}
      </section>
      <section className="inspector-detail-section">
        <h5>Used by</h5>
        {usedBy.length === 0 ? (
          <p className="inspector-muted">(no transform declares this type)</p>
        ) : (
          <div className="inspector-chip-row">
            {usedBy.map((t) => (
              <TransformKeyChip
                key={t.key}
                transformKey={t.key}
                name={t.name}
                onClick={() => onJumpToTransform(t.key)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
