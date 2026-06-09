import type { ViewTransform } from '../../transforms/types.ts';
import { SelectorKeyChip } from './chips.tsx';
import { SourceView } from './SourceView.tsx';
import { TRANSFORM_SOURCE } from './sources.ts';

export function TransformsDetail({
  transform,
  onJumpToType,
}: {
  transform: ViewTransform | null;
  onJumpToType: (selectorKey: string) => void;
}) {
  if (!transform) {
    return (
      <div className="inspector-detail inspector-detail-empty">
        <p>Select a transform to inspect.</p>
      </div>
    );
  }
  const matches = transform.matches ?? [];
  const source = TRANSFORM_SOURCE[transform.key] ?? '';
  const views = transform.views ? transform.views.join(', ') : 'all';
  return (
    <div className="inspector-detail">
      <header className="inspector-detail-header">
        <h4 className="inspector-detail-name">{transform.name}</h4>
        <code className="inspector-detail-key">{transform.key}</code>
      </header>
      <div className="inspector-detail-meta">
        <span className={`inspector-stage inspector-stage-${transform.stage}`}>
          stage {transform.stage}
        </span>
        <span className="inspector-views">views: {views}</span>
      </div>
      {transform.description && (
        <p className="inspector-detail-desc">{transform.description}</p>
      )}
      <section className="inspector-detail-section">
        <h5>Matches</h5>
        {matches.length === 0 ? (
          <p className="inspector-muted">(no declared match — runs against every event)</p>
        ) : (
          <div className="inspector-chip-row">
            {matches.map((k) => (
              <SelectorKeyChip key={k} selectorKey={k} onClick={() => onJumpToType(k)} />
            ))}
          </div>
        )}
      </section>
      <section className="inspector-detail-section">
        <h5>Source</h5>
        {source ? (
          <SourceView source={source} />
        ) : (
          <p className="inspector-muted">(source not in manifest)</p>
        )}
      </section>
    </div>
  );
}
