import { useEffect } from 'react';
import { PanelCard } from './components/PanelCard.tsx';
import { LightboxProvider } from './lib/lightbox.tsx';
import { useBoolPref, useTheme } from './lib/preferences.ts';
import { trpc } from './trpc.ts';
import { type PanelState, useDeltaStream } from './useDeltaStream.ts';
import './app.css';

export function App() {
  const { status, panels } = useDeltaStream();
  const [theme, setTheme] = useTheme();
  const [imessage, setIMessage] = useBoolPref('brainhouse-imessage', false);
  const [hideMeta, setHideMeta] = useBoolPref('brainhouse-hide-meta', false);
  const [showElapsed, setShowElapsed] = useBoolPref('brainhouse-elapsed', false);
  const [conversation, setConversation] = useBoolPref('brainhouse-convo', false);

  useEffect(() => {
    document.body.classList.toggle('imessage', imessage);
    document.body.classList.toggle('hide-meta', hideMeta);
    document.body.classList.toggle('show-elapsed', showElapsed);
    document.body.classList.toggle('view-conversation', conversation);
  }, [imessage, hideMeta, showElapsed, conversation]);

  const focusedId = new URLSearchParams(location.search).get('panel');
  if (focusedId) {
    const focused = panels.get(focusedId);
    return (
      <LightboxProvider>
        <header className="topbar">
          <h1>brainhouse · {focused?.title ?? focusedId}</h1>
          <span className={`conn conn-${status}`}>{status}</span>
        </header>
        <main className="grid focused">{focused && <PanelCard panel={focused} />}</main>
      </LightboxProvider>
    );
  }

  const { gridPanels, trayPanels, subsByParent } = layoutPanels(panels);

  return (
    <LightboxProvider>
      <header className="topbar">
        <h1>brainhouse</h1>
        <span className="topbar-controls">
          <Toggle label="hide meta" checked={hideMeta} onChange={setHideMeta} />
          <Toggle label="iMessage style" checked={imessage} onChange={setIMessage} />
          <Toggle label="show elapsed" checked={showElapsed} onChange={setShowElapsed} />
          <Toggle label="conversation view" checked={conversation} onChange={setConversation} />
          <button
            type="button"
            className="theme-toggle"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            type="button"
            className="debug-spawn"
            onClick={() => trpc.debug.spawnMock.mutate()}
          >
            + mock session
          </button>
          <button
            type="button"
            className="debug-spawn"
            onClick={() => trpc.debug.spawnCounter.mutate({ stopAt: 10 })}
          >
            + counter subagent
          </button>
          <span className={`conn conn-${status}`}>{status}</span>
        </span>
      </header>
      <main className="grid" onDragOver={onGridDragOver} onDrop={onGridDrop}>
        {gridPanels.map((p) => (
          <PanelWithSubagents key={p.id} panel={p} subagents={subsByParent.get(p.id) ?? []} />
        ))}
        {gridPanels.length === 0 && trayPanels.length === 0 && status === 'live' && (
          <p className="empty">no sessions yet — try `+ mock session`</p>
        )}
      </main>
      <aside className="mini-tray">
        {trayPanels.map((p) => (
          <MiniPanel key={p.id} panel={p} />
        ))}
        {trayPanels.length === 0 && <span className="tray-empty">no completed sessions</span>}
      </aside>
    </LightboxProvider>
  );
}

function PanelWithSubagents({ panel, subagents }: { panel: PanelState; subagents: PanelState[] }) {
  const live = subagents.filter((s) => s.status === 'live');
  const rest = subagents.filter((s) => s.status === 'done');
  return (
    <div className="panel-group">
      <PanelCard panel={panel} />
      {(live.length > 0 || rest.length > 0) && (
        <div className="panel-subagents">
          {[...live, ...rest].map((s) => (
            <PanelCard key={s.id} panel={s} nested />
          ))}
        </div>
      )}
    </div>
  );
}

function MiniPanel({ panel }: { panel: PanelState }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/brainhouse-panel', panel.id);
      }}
    >
      <PanelCard panel={panel} />
    </div>
  );
}

function onGridDragOver(e: React.DragEvent) {
  if (!e.dataTransfer.types.includes('text/brainhouse-panel')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onGridDrop(e: React.DragEvent) {
  const id = e.dataTransfer.getData('text/brainhouse-panel');
  if (!id) return;
  e.preventDefault();
  trpc.restore.mutate({ panelId: id });
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

interface Layout {
  gridPanels: PanelState[];
  trayPanels: PanelState[];
  subsByParent: Map<string, PanelState[]>;
}

function layoutPanels(panels: Map<string, PanelState>): Layout {
  const all = Array.from(panels.values());
  const subsByParent = new Map<string, PanelState[]>();
  for (const p of all) {
    if (p.kind === 'subagent' && p.parent_panel_id && panels.has(p.parent_panel_id)) {
      const arr = subsByParent.get(p.parent_panel_id) ?? [];
      arr.push(p);
      subsByParent.set(p.parent_panel_id, arr);
    }
  }
  const gridPanels: PanelState[] = [];
  const trayPanels: PanelState[] = [];
  for (const p of all) {
    if (p.kind === 'parent') {
      if (p.status === 'mini') trayPanels.push(p);
      else gridPanels.push(p);
    } else if (p.parent_panel_id == null || !panels.has(p.parent_panel_id)) {
      // Orphan subagent: place by its own status.
      if (p.status === 'mini') trayPanels.push(p);
      else gridPanels.push(p);
    }
    // Otherwise the subagent renders inside its parent's nested tray via subsByParent.
  }
  return { gridPanels, trayPanels, subsByParent };
}
