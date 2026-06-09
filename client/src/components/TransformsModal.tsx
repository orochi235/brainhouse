/**
 * Debug view of the event → view-item transforms. Reads directly from
 * the registry in `../transforms/registry.ts`, so adding a transform
 * shows up here for free.
 *
 * When opened with a `panelId` (and the panel's events + final items),
 * a second tab — Trace — surfaces the runtime instrumentation owned by
 * Spec 3. When opened from the global toolbar with no panel context,
 * only the Pipeline tab is shown.
 */

import type { Event } from '@server/parser.ts';
import classNames from 'classnames';
import { useState } from 'react';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { VIEW_TRANSFORMS } from '../transforms/registry.ts';
import { useTransformToggles } from '../transforms/useTransformToggles.ts';
import { TraceTab } from './TraceTab.tsx';

interface TransformsModalProps {
  panelId?: string;
  events?: Event[];
  items?: ViewItem[];
}

type Tab = 'pipeline' | 'trace';

export function TransformsModal({ panelId, events, items }: TransformsModalProps = {}) {
  const hasPanelContext = !!panelId && !!events && !!items;
  const [tab, setTab] = useState<Tab>('pipeline');
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline transforms</h3>
      {hasPanelContext && (
        <div className="transforms-tab-strip" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pipeline'}
            className={classNames('transforms-tab', tab === 'pipeline' && 'is-active')}
            onClick={() => setTab('pipeline')}
          >
            Pipeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'trace'}
            className={classNames('transforms-tab', tab === 'trace' && 'is-active')}
            onClick={() => setTab('trace')}
          >
            Trace
          </button>
        </div>
      )}
      {tab === 'pipeline' && (
        <PipelineList panelId={hasPanelContext ? panelId : undefined} />
      )}
      {tab === 'trace' && hasPanelContext && (
        <TraceTab panelId={panelId} events={events} items={items} />
      )}
    </div>
  );
}

function PipelineList({ panelId }: { panelId?: string }) {
  // When a panelId is supplied, surface the per-panel toggle map so the
  // catalog shows what's currently disabled. Spec 2 will replace this
  // with a real checkbox column on Tab B; we just dim the row for now.
  const toggles = useTransformToggles(panelId ?? '__noop__');
  const anyDisabled = panelId
    ? Object.values(toggles.all).some((v) => v === false)
    : false;
  return (
    <>
      <p className="transforms-intro">
        Event → view-item transforms applied by <code>preprocessEvents()</code>. Stage 1 walks the
        event list and emits view items; stage 2 reshapes them.
      </p>
      <ol className="transforms-list">
        {VIEW_TRANSFORMS.map((t) => {
          const disabled = panelId && toggles.all[t.key] === false;
          return (
            <li
              className={classNames(
                'transforms-item',
                `transforms-pass-${t.stage}`,
                disabled && 'transforms-item-disabled',
              )}
              key={t.key}
            >
              <div className="transforms-row">
                <span className="transforms-name">{t.name}</span>
                <span className="transforms-stage">{`stage ${t.stage}`}</span>
              </div>
              <div className="transforms-source">{t.key}</div>
              <p className="transforms-blurb">{t.description}</p>
              {panelId && (
                <button
                  type="button"
                  className="transforms-toggle-btn"
                  onClick={() => toggles.set(t.key, disabled === true)}
                >
                  {disabled ? 'enable on this panel' : 'disable on this panel'}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {anyDisabled && panelId && (
        <button
          type="button"
          className="trace-reset-toggles"
          onClick={() => toggles.resetAll()}
        >
          Reset toggles ({Object.values(toggles.all).filter((v) => v === false).length} disabled)
        </button>
      )}
    </>
  );
}
