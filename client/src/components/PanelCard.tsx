import classNames from 'classnames';
import type { PanelState } from '../useDeltaStream.ts';
import { EventList } from './EventList.tsx';

export function PanelCard({ panel }: { panel: PanelState }) {
  return (
    <article
      className={classNames('panel', `panel-${panel.kind}`, `status-${panel.status}`)}
      data-panel-id={panel.id}
    >
      <header className="panel-header">
        <span className="panel-title">{panel.title}</span>
        <span className={`panel-status ${panel.status}`}>{panel.status}</span>
      </header>
      <div className="panel-body">
        <EventList events={panel.events} />
      </div>
    </article>
  );
}
