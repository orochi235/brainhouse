import { PanelCard } from './components/PanelCard.tsx';
import { trpc } from './trpc.ts';
import { type PanelState, useDeltaStream } from './useDeltaStream.ts';
import './app.css';

export function App() {
  const { status, panels } = useDeltaStream();
  const ordered = orderPanels(panels);

  return (
    <>
      <header className="topbar">
        <h1>brainhouse</h1>
        <span className="topbar-controls">
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
      <main className="grid">
        {ordered.map((panel) => (
          <PanelCard key={panel.id} panel={panel} />
        ))}
        {ordered.length === 0 && status === 'live' && <p className="empty">no sessions yet</p>}
      </main>
    </>
  );
}

/** Parent panels followed by their subagents (live first within each group). */
function orderPanels(panels: Map<string, PanelState>): PanelState[] {
  const all = Array.from(panels.values());
  const parents = all.filter((p) => p.kind === 'parent');
  const subsByParent = new Map<string, PanelState[]>();
  for (const p of all) {
    if (p.kind === 'subagent' && p.parent_panel_id) {
      const arr = subsByParent.get(p.parent_panel_id) ?? [];
      arr.push(p);
      subsByParent.set(p.parent_panel_id, arr);
    }
  }
  const out: PanelState[] = [];
  for (const parent of parents) {
    const subs = subsByParent.get(parent.id) ?? [];
    const live = subs.filter((s) => s.status === 'live');
    const rest = subs.filter((s) => s.status !== 'live');
    out.push(...live, parent, ...rest);
  }
  // Orphan subagents (no parent known): tack onto the end.
  for (const p of all) {
    if (p.kind === 'subagent' && (!p.parent_panel_id || !panels.has(p.parent_panel_id))) {
      out.push(p);
    }
  }
  return out;
}
