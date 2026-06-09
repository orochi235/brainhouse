/**
 * Top-level inspector. Owns the tab strip (Types / Transforms / Trace) and
 * forwards hash-route state down to each tab. Trace renders the live
 * Spec 3 view when opened with a panel context; otherwise it falls back
 * to a placeholder card.
 */

import type { Event } from '@server/parser.ts';
import type { ViewItem } from '../../lib/pipeline-types.ts';
import { TraceTab } from '../TraceTab.tsx';
import { TransformsTab } from './TransformsTab.tsx';
import { TypesTab } from './TypesTab.tsx';
import { type InspectorTab, useHashRoute } from './useHashRoute.ts';

interface TransformsInspectorProps {
  panelId?: string;
  events?: Event[];
  items?: ViewItem[];
}

const TABS: { key: InspectorTab; label: string }[] = [
  { key: 'types', label: 'Types' },
  { key: 'transforms', label: 'Transforms' },
  { key: 'trace', label: 'Trace' },
];

export function TransformsInspector({ panelId, events, items }: TransformsInspectorProps = {}) {
  const hasPanelContext = !!panelId && !!events && !!items;
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
            {t.key === 'trace' && !hasPanelContext && (
              <span className="inspector-tab-soon">panel only</span>
            )}
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
        {tab === 'trace' && hasPanelContext && (
          <TraceTab panelId={panelId} events={events} items={items} />
        )}
        {tab === 'trace' && !hasPanelContext && (
          <div className="inspector-trace-placeholder">
            <h4>Live trace needs a panel context</h4>
            <p className="inspector-muted">
              Open the inspector from a specific panel (the <code>tr</code> tool chip in the
              debug palette) to see which transforms fired against which events.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
