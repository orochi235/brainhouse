/**
 * Top-level inspector. Owns the tab strip (Types / Transforms / Trace) and
 * forwards hash-route state down to each tab. Trace renders a placeholder
 * card until Spec 3 ships.
 */

import { TransformsTab } from './TransformsTab.tsx';
import { TypesTab } from './TypesTab.tsx';
import { type InspectorTab, useHashRoute } from './useHashRoute.ts';

const TABS: { key: InspectorTab; label: string }[] = [
  { key: 'types', label: 'Types' },
  { key: 'transforms', label: 'Transforms' },
  { key: 'trace', label: 'Trace' },
];

export function TransformsInspector() {
  const { route, setRoute } = useHashRoute('types');
  const tab: InspectorTab = route.tab ?? 'types';
  const selectedKey = route.key;

  const setTab = (next: InspectorTab) => setRoute({ tab: next, key: null });
  const selectInTab = (next: InspectorTab, key: string | null) =>
    setRoute({ tab: next, key });

  return (
    <div className="transforms-inspector">
      <nav className="inspector-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={`inspector-tab${t.key === tab ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === 'trace' && <span className="inspector-tab-soon">soon</span>}
          </button>
        ))}
      </nav>
      <div className="inspector-body">
        {tab === 'types' && (
          <TypesTab
            selectedKey={selectedKey}
            onSelect={(k) => selectInTab('types', k)}
            onJumpToTransform={(k) => selectInTab('transforms', k)}
          />
        )}
        {tab === 'transforms' && (
          <TransformsTab
            selectedKey={selectedKey}
            onSelect={(k) => selectInTab('transforms', k)}
            onJumpToType={(k) => selectInTab('types', k)}
          />
        )}
        {tab === 'trace' && (
          <div className="inspector-trace-placeholder">
            <h4>Live trace — coming in Spec 3</h4>
            <p className="inspector-muted">
              This tab will let you watch which transforms fire against which events as the
              panel runs. Tracked separately to keep the browse/author flows here shippable
              today.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
