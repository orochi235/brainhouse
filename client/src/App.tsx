import classNames from 'classnames';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { FlowsModal } from './components/FlowsModal.tsx';
import { PanelCard } from './components/PanelCard.tsx';
import { PrefsModal } from './components/PrefsModal.tsx';
import { ScenariosModal } from './components/ScenariosModal.tsx';
import { StatsModal } from './components/StatsModal.tsx';
import { TransformsModal } from './components/TransformsModal.tsx';
import { useGridLayout } from './lib/gridLayout.ts';
import { usePanelDismissal } from './lib/hiddenPanels.ts';
import { LightboxProvider, useLightbox } from './lib/lightbox.tsx';
import {
  sortByOrder,
  useBrokenOutPanels,
  usePanelOrder,
  usePinnedPanels,
  useWidePanels,
} from './lib/panelOrder.ts';
import { useTheme } from './lib/preferences.ts';
import { useIntentions } from './lib/useIntentions.ts';
import { usePrefs } from './lib/usePrefs.ts';
import { trpc } from './trpc.ts';
import { type PanelState, useDeltaStream } from './useDeltaStream.ts';
import './app.css';

export function App() {
  const { status, panels } = useDeltaStream();
  const [theme, setTheme] = useTheme();
  const { prefs, refetch: refetchPrefs } = usePrefs();

  // Suppress mount animations during the initial render burst — when the
  // first snapshot lands and 20+ panels spawn at once, the `panel-spawn`
  // animation cost stutters. We carry a `loading-quiet` body class until
  // the snapshot has been applied, then drop it on the next paint so
  // subsequent panel arrivals still animate.
  useEffect(() => {
    document.body.classList.add('loading-quiet');
  }, []);
  useEffect(() => {
    if (status !== 'live') return;
    // Two rAFs: one to let the snapshot-driven render commit, one to let
    // the browser paint it before we re-enable animations.
    let raf2: number | undefined;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        document.body.classList.remove('loading-quiet');
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
    };
  }, [status]);
  const { imessage, showElapsed, conversation } = prefs.display;
  const showAccountBadges = prefs.roots.length > 1;
  const accountFor = (p: PanelState): string | null | undefined =>
    showAccountBadges ? p.account_label : undefined;
  // Lookup color by account label; PanelCard stamps it as --account-color so
  // the badge + border pick up the per-account hue. Falls back to the global
  // accent when no color is configured.
  const accountColorByLabel = new Map<string, string>(
    prefs.roots.filter((r) => r.label && r.color).map((r) => [r.label as string, r.color as string]),
  );
  const accountColorFor = (p: PanelState): string | undefined => {
    if (!showAccountBadges) return undefined;
    return p.account_label ? accountColorByLabel.get(p.account_label) : undefined;
  };
  const { seeded, persist: persistIntention } = useIntentions();
  const { order, moveBefore } = usePanelOrder({
    initial: seeded.order,
    persist: (id, manual_order) => persistIntention(id, { manual_order }),
  });
  const { wide, toggleWide } = useWidePanels({
    initial: seeded.wide,
    persist: (id, value) => persistIntention(id, { wide: value }),
  });
  const { pinned, togglePin } = usePinnedPanels({
    initial: seeded.pinned,
    persist: (id, value) => persistIntention(id, { pinned: value }),
  });
  const { brokenOut, toggleBrokenOut } = useBrokenOutPanels({
    initial: seeded.brokenOut,
    persist: (id, value) => persistIntention(id, { broken_out: value }),
  });
  const {
    dismiss,
    dismissAll,
    restore: restoreLocal,
    isHidden,
    isClientMini,
  } = usePanelDismissal(panels, {
    initial: seeded.dismissal,
    persist: (id, patch) => persistIntention(id, patch),
  });

  useEffect(() => {
    document.body.classList.toggle('imessage', imessage);
    document.body.classList.toggle('show-elapsed', showElapsed);
    document.body.classList.toggle('view-conversation', conversation);
    const m = prefs.messages;
    document.body.classList.toggle('hide-thinking', !m.thinking);
    document.body.classList.toggle('hide-system', !m.system);
    document.body.classList.toggle('hide-meta', !m.meta);
    document.body.classList.toggle('hide-tools', !m.tools);
    document.body.classList.toggle('hide-file-changes', !m.fileChanges);
    document.body.classList.toggle('hide-op-strips', !m.opStrips);
    document.documentElement.style.setProperty(
      '--idle-opacity',
      String(prefs.display.idleOpacity),
    );
    document.documentElement.style.setProperty(
      '--hued-header-strength',
      String(prefs.display.huedHeaderStrength),
    );
    document.body.classList.toggle(
      'tool-palette-always',
      prefs.display.toolPaletteDisplay === 'always',
    );
    document.body.classList.toggle('hide-session-time', !prefs.display.showSessionTime);
    document.body.classList.toggle('hide-tokens', !prefs.display.showTokens);
    document.body.classList.toggle('hide-context', !prefs.display.showContext);
  }, [
    imessage,
    showElapsed,
    conversation,
    prefs.messages,
    prefs.display.idleOpacity,
    prefs.display.huedHeaderStrength,
    prefs.display.toolPaletteDisplay,
    prefs.display.showSessionTime,
    prefs.display.showTokens,
    prefs.display.showContext,
  ]);

  // Auto-minimize newly-arriving subagent panels when the pref is on. We
  // track which ids we've already routed so toggling the pref off (or
  // restoring from the dock) doesn't keep re-minimizing on every render.
  const autoMinifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!prefs.workspace.spawnSubagentsMinimized) return;
    for (const p of panels.values()) {
      if (p.kind !== 'subagent') continue;
      if (autoMinifiedRef.current.has(p.id)) continue;
      autoMinifiedRef.current.add(p.id);
      // Only minimize live subagents the user hasn't already touched.
      if (p.status === 'live' && !isClientMini(p) && !isHidden(p)) {
        dismiss(p);
      }
    }
  }, [panels, prefs.workspace.spawnSubagentsMinimized, dismiss, isClientMini, isHidden]);

  // ESC dismisses a fullscreen panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const fs = document.querySelector('.panel.fullscreen');
      if (fs) {
        fs.classList.remove('fullscreen');
        document.body.classList.remove('has-fullscreen-panel');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const {
    gridPanels: allGridPanels,
    trayPanels: allTrayPanels,
    subsByParent: allSubsByParent,
  } = layoutPanels(panels, brokenOut);
  // Pinned panels always stay in the grid, never dim, never demote — they
  // override hidden / clientMini / server-mini routing.
  const isPinned = (p: PanelState) => pinned.has(p.id);

  // Dismissed panels move to the tray regardless of kind, unless pinned.
  const clientMiniPanels = allGridPanels.filter((p) => !isPinned(p) && isClientMini(p));
  const clientMiniSubs: PanelState[] = [];
  const subsByParent = new Map<string, PanelState[]>();
  for (const [parentId, subs] of allSubsByParent) {
    const kept: PanelState[] = [];
    for (const s of subs) {
      if (!isPinned(s) && isHidden(s)) continue;
      if (!isPinned(s) && isClientMini(s)) clientMiniSubs.push(s);
      else kept.push(s);
    }
    if (kept.length) subsByParent.set(parentId, kept);
  }
  const gridPanels = [
    ...allGridPanels.filter((p) => isPinned(p) || (!isHidden(p) && !isClientMini(p))),
    // Pinned panels the server demoted to mini get promoted back to the grid.
    ...allTrayPanels.filter(isPinned),
  ];
  const trayPanels = [
    ...allTrayPanels.filter((p) => !isPinned(p)),
    ...clientMiniPanels,
    ...clientMiniSubs,
  ].filter((p) => !isHidden(p));
  const orderedGridIds = sortByOrder(
    gridPanels.map((p) => p.id),
    order,
  );
  const orderedGridPanels = orderedGridIds
    .map((id) => gridPanels.find((p) => p.id === id))
    .filter((p): p is PanelState => p !== undefined);

  // Wide panels consume two cells; everything else consumes one. We pass the
  // total slot count to the layout hook so a 4-panel grid with one wide panel
  // becomes a 5-slot tile (still picks a nice integer cols/rows).
  const wideCount = orderedGridPanels.reduce((n, p) => n + (wide.has(p.id) ? 1 : 0), 0);
  const slots = orderedGridPanels.length + wideCount;
  const { ref: gridRef, cols, rows } = useGridLayout(slots);
  const gridStyle = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };

  const focusedId = new URLSearchParams(location.search).get('panel');
  if (focusedId) {
    const focused = panels.get(focusedId);
    return (
      <LightboxProvider>
        <header className="topbar">
          <h1>Brainhouse · {focused?.title ?? focusedId}</h1>
          <span className={`conn conn-${status}`}>{status}</span>
        </header>
        <main className="session-grid focused">
          {focused && (
            <PanelCard
              panel={focused}
              account={accountFor(focused)}
              accountColor={accountColorFor(focused)}
            />
          )}
        </main>
      </LightboxProvider>
    );
  }

  return (
    <LightboxProvider>
      <header className="topbar">
        <h1>Brainhouse</h1>
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
          <button type="button" className="debug-spawn" onClick={dismissAll}>
            clear all
          </button>
          <ScenariosButton />
          <TransformsButton />
          <StatsButton />
          <FlowsButton />
          <span className={`conn conn-${status}`}>{status}</span>
          <span className="topbar-icon-buttons">
            <button
              type="button"
              className="theme-toggle"
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? '☾' : '☀'}
            </button>
            <PrefsButton prefs={prefs} onSaved={refetchPrefs} />
          </span>
        </span>
      </header>
      <LayoutGroup>
        <main
          className="session-grid"
          ref={gridRef}
          style={gridStyle}
          onDragOver={onGridDragOver}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('text/brainhouse-panel');
            if (!id) return;
            e.preventDefault();
            // Client-mini panels live entirely in client state; restoring them
            // is a local op. Server-mini panels need an explicit trpc.restore.
            if (clientMiniPanels.some((p) => p.id === id)) restoreLocal(id);
            else trpc.restore.mutate({ panelId: id });
          }}
        >
          <AnimatePresence initial={false}>
            {orderedGridPanels.map((p) => (
              <GridSlot
                key={p.id}
                panel={p}
                subagents={subsByParent.get(p.id) ?? []}
                wide={wide.has(p.id)}
                pinned={pinned.has(p.id)}
                account={accountFor(p)}
                accountColor={accountColorFor(p)}
                accountFor={accountFor}
                accountColorFor={accountColorFor}
                onToggleWide={() => toggleWide(p.id)}
                onTogglePin={() => togglePin(p.id)}
                onTogglePinSub={(s) => togglePin(s.id)}
                isPinnedSub={(s) => pinned.has(s.id)}
                onHide={() => dismiss(p)}
                onHideSub={(s) => dismiss(s)}
                brokenOutSubs={brokenOut}
                onToggleBrokenOutSub={(s) => toggleBrokenOut(s.id)}
                onReorder={(srcId) =>
                  moveBefore(
                    srcId,
                    p.id,
                    orderedGridPanels.map((g) => g.id),
                  )
                }
              />
            ))}
          </AnimatePresence>
          {orderedGridPanels.length === 0 && trayPanels.length === 0 && status === 'live' && (
            <p className="empty">no sessions yet — try `+ mock session`</p>
          )}
        </main>
        {trayPanels.length > 0 && (
          <aside className="session-dock">
            <AnimatePresence initial={false}>
              {trayPanels.map((p) => (
                <MiniPanel
                  key={p.id}
                  panel={p}
                  onHide={() => dismiss(p)}
                  onRestore={() => {
                    // Client-mini panels restore locally; server-mini ones need trpc.
                    if (clientMiniPanels.some((m) => m.id === p.id)) restoreLocal(p.id);
                    else if (clientMiniSubs.some((m) => m.id === p.id)) restoreLocal(p.id);
                    else trpc.restore.mutate({ panelId: p.id });
                  }}
                  pinned={pinned.has(p.id)}
                  onTogglePin={() => togglePin(p.id)}
                  account={accountFor(p)}
                  accountColor={accountColorFor(p)}
                />
              ))}
            </AnimatePresence>
          </aside>
        )}
      </LayoutGroup>
    </LightboxProvider>
  );
}

/**
 * One slot in the main grid. The wrapper handles drop targeting; the panel
 * header is the drag handle (we arm `draggable` only on mousedown over the
 * header so users can still click buttons / select text inside the body).
 * Double-clicking the header toggles "wide" (span 2 columns).
 *
 * Drops from the session-dock are forwarded up to the .session-grid handler unchanged
 * so they still trigger trpc.restore.
 */
function GridSlot({
  panel,
  subagents,
  wide,
  pinned,
  account,
  accountColor,
  accountFor,
  accountColorFor,
  onToggleWide,
  onTogglePin,
  onTogglePinSub,
  isPinnedSub,
  onHide,
  onHideSub,
  onReorder,
  brokenOutSubs,
  onToggleBrokenOutSub,
}: {
  panel: PanelState;
  subagents: PanelState[];
  wide: boolean;
  pinned: boolean;
  account: string | null | undefined;
  accountColor: string | undefined;
  accountFor: (p: PanelState) => string | null | undefined;
  accountColorFor: (p: PanelState) => string | undefined;
  onToggleWide: () => void;
  onTogglePin: () => void;
  onTogglePinSub: (sub: PanelState) => void;
  isPinnedSub: (sub: PanelState) => boolean;
  onHide: () => void;
  onHideSub: (sub: PanelState) => void;
  onReorder: (sourceId: string) => void;
  brokenOutSubs: Set<string>;
  onToggleBrokenOutSub: (sub: PanelState) => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <motion.div
      layout
      // Enter: appear from slightly-shrunken with a soft fade; exit reverses
      // it. The existing soft-remove dance (panel.removing → 600ms class) is
      // independent of this; framer drives mounted-state transitions only.
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.6 }}
      className={classNames('grid-slot', wide && 'wide')}
      draggable={armed}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        const inHeader = !!t.closest('.panel-header');
        const onButton = !!t.closest('button');
        setArmed(inHeader && !onButton);
      }}
      onMouseUp={() => setArmed(false)}
      // motion.div narrows onDragStart/onDragEnd to framer's pointer-event
      // signatures because of its internal `drag` prop; we're using native
      // HTML5 drag instead, so cast at the boundary.
      onDragStart={(rawE) => {
        const e = rawE as unknown as React.DragEvent<HTMLDivElement>;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/brainhouse-panel', panel.id);
        e.dataTransfer.setData('text/brainhouse-panel-source', 'grid');
        (e.currentTarget as HTMLElement).classList.add('dragging');
      }}
      onDragEnd={(rawE) => {
        const e = rawE as unknown as React.DragEvent<HTMLDivElement>;
        (e.currentTarget as HTMLElement).classList.remove('dragging');
        setArmed(false);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/brainhouse-panel')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        (e.currentTarget as HTMLElement).classList.add('drop-target');
      }}
      onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('drop-target')}
      onDrop={(e) => {
        (e.currentTarget as HTMLElement).classList.remove('drop-target');
        const src = e.dataTransfer.getData('text/brainhouse-panel');
        const from = e.dataTransfer.getData('text/brainhouse-panel-source');
        if (!src || from !== 'grid') return;
        e.preventDefault();
        e.stopPropagation();
        onReorder(src);
      }}
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest('.panel-header')) return;
        if (t.closest('button')) return;
        onToggleWide();
      }}
    >
      <PanelWithSubagents
        panel={panel}
        subagents={subagents}
        pinned={pinned}
        account={account}
        accountColor={accountColor}
        accountFor={accountFor}
        accountColorFor={accountColorFor}
        onTogglePin={onTogglePin}
        onTogglePinSub={onTogglePinSub}
        isPinnedSub={isPinnedSub}
        onHide={onHide}
        onHideSub={onHideSub}
        brokenOutSubs={brokenOutSubs}
        onToggleBrokenOutSub={onToggleBrokenOutSub}
      />
    </motion.div>
  );
}

function PanelWithSubagents({
  panel,
  subagents,
  pinned,
  account,
  accountColor,
  accountFor,
  accountColorFor,
  onTogglePin,
  onTogglePinSub,
  isPinnedSub,
  onHide,
  onHideSub,
  brokenOutSubs,
  onToggleBrokenOutSub,
}: {
  panel: PanelState;
  subagents: PanelState[];
  pinned: boolean;
  account: string | null | undefined;
  accountColor: string | undefined;
  accountFor: (p: PanelState) => string | null | undefined;
  accountColorFor: (p: PanelState) => string | undefined;
  onTogglePin: () => void;
  onTogglePinSub: (sub: PanelState) => void;
  isPinnedSub: (sub: PanelState) => boolean;
  onHide: () => void;
  onHideSub: (sub: PanelState) => void;
  brokenOutSubs: Set<string>;
  onToggleBrokenOutSub: (sub: PanelState) => void;
}) {
  const live = subagents.filter((s) => s.status === 'live');
  const rest = subagents.filter((s) => s.status === 'done');
  return (
    <div className="panel-group">
      <PanelCard
        panel={panel}
        onHide={onHide}
        pinned={pinned}
        onTogglePin={onTogglePin}
        brokenOut={brokenOutSubs.has(panel.id)}
        onToggleBrokenOut={
          panel.kind === 'subagent' ? () => onToggleBrokenOutSub(panel) : undefined
        }
        account={account}
        accountColor={accountColor}
      />
      {(live.length > 0 || rest.length > 0) && (
        <div className="panel-subagents">
          {[...live, ...rest].map((s) => (
            <PanelCard
              key={s.id}
              panel={s}
              nested
              onHide={() => onHideSub(s)}
              pinned={isPinnedSub(s)}
              onTogglePin={() => onTogglePinSub(s)}
              brokenOut={brokenOutSubs.has(s.id)}
              onToggleBrokenOut={() => onToggleBrokenOutSub(s)}
              account={accountFor(s)}
              accountColor={accountColorFor(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MiniPanel({
  panel,
  onHide,
  onRestore,
  account,
  accountColor,
  // Kept for API completeness; mini-mode currently doesn't surface the pin
  // toggle (user preference). To re-enable, forward both props to PanelCard.
  pinned: _pinned,
  onTogglePin: _onTogglePin,
}: {
  panel: PanelState;
  onHide: () => void;
  onRestore: () => void;
  account: string | null | undefined;
  accountColor: string | undefined;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.5 }}
      draggable
      onDragStart={(rawE) => {
        const e = rawE as unknown as React.DragEvent<HTMLDivElement>;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/brainhouse-panel', panel.id);
        // Pin the drag image to the dragged element itself — otherwise the
        // browser snapshots a region that ends up including sibling mini
        // panels (and a sliver of the dock's scrollbar) because the dock
        // is `overflow-x: auto` and framer-motion's live transform on the
        // sibling motion.divs confuses the default drag-image heuristic.
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        e.dataTransfer.setDragImage(target, e.clientX - rect.left, e.clientY - rect.top);
      }}
    >
      <PanelCard
        panel={panel}
        onHide={onHide}
        onRestore={onRestore}
        account={account}
        accountColor={accountColor}
      />
    </motion.div>
  );
}

function onGridDragOver(e: React.DragEvent) {
  if (!e.dataTransfer.types.includes('text/brainhouse-panel')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function ScenariosButton() {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className="debug-spawn"
      title="Spawn a synthetic scenario that exercises specific UI/lifecycle paths"
      onClick={() => lightbox.open(<ScenariosModal />)}
    >
      scenarios
    </button>
  );
}

function TransformsButton() {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className="debug-spawn"
      title="Show the pipeline transforms applied to every event stream"
      onClick={() => lightbox.open(<TransformsModal />)}
    >
      transforms
    </button>
  );
}

function StatsButton() {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className="debug-spawn"
      title="Cross-session event-type counts — what kinds + subkeys we actually see"
      onClick={() => lightbox.open(<StatsModal />)}
    >
      stats
    </button>
  );
}

function FlowsButton() {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className="debug-spawn"
      title="Sankey of which event types tend to follow which, across all sessions"
      onClick={() => lightbox.open(<FlowsModal />)}
    >
      flows
    </button>
  );
}

function PrefsButton({
  prefs,
  onSaved,
}: { prefs: import('./lib/usePrefs.ts').ClientPrefs; onSaved?: () => void }) {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      className="theme-toggle theme-toggle-prefs"
      title="Preferences"
      onClick={() =>
        lightbox.open(
          <PrefsModal
            initial={prefs}
            onClose={() => {
              lightbox.close();
              onSaved?.();
            }}
          />,
        )
      }
    >
      ⚙
    </button>
  );
}

interface Layout {
  gridPanels: PanelState[];
  trayPanels: PanelState[];
  subsByParent: Map<string, PanelState[]>;
}

function layoutPanels(panels: Map<string, PanelState>, brokenOut: Set<string>): Layout {
  const all = Array.from(panels.values());
  const subsByParent = new Map<string, PanelState[]>();
  for (const p of all) {
    if (
      p.kind === 'subagent' &&
      p.parent_panel_id &&
      panels.has(p.parent_panel_id) &&
      !brokenOut.has(p.id)
    ) {
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
    } else if (
      p.parent_panel_id == null ||
      !panels.has(p.parent_panel_id) ||
      brokenOut.has(p.id)
    ) {
      // Orphan subagent OR one the user has explicitly broken out: place
      // by its own status, top-level.
      if (p.status === 'mini') trayPanels.push(p);
      else gridPanels.push(p);
    }
    // Otherwise the subagent renders inside its parent's nested tray via subsByParent.
  }
  return { gridPanels, trayPanels, subsByParent };
}
