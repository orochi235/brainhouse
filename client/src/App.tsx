import classNames from 'classnames';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { ConnTooltip } from './components/ConnTooltip.tsx';
import { DebugDock, loadPanelOpen, savePanelOpen } from './components/DebugDock.tsx';
import { DebugTile } from './components/DebugTile.tsx';
import { FlowsModal } from './components/FlowsModal.tsx';
import { HoverPopover } from './components/HoverPopover.tsx';
import { PanelCard } from './components/PanelCard.tsx';
import { PrefsModal } from './components/PrefsModal.tsx';
import { ProcessesPanel } from './components/ProcessesPanel.tsx';
import { ProjectWidgetCard, ProjectWidgetChip } from './components/ProjectWidgetCard.tsx';
import { ScenariosModal } from './components/ScenariosModal.tsx';
import { StatsModal } from './components/StatsModal.tsx';
import { TransformsModal } from './components/TransformsModal.tsx';
import { UptimeClock } from './components/UptimeClock.tsx';
import { Layout } from './layout/Layout.tsx';
import { getActiveDrag, setActiveDrag } from './lib/activeDrag.ts';
import { debugEnabled } from './lib/debugMode.ts';
import { useGridLayout } from './lib/gridLayout.ts';
import { usePanelDismissal } from './lib/hiddenPanels.ts';
import { useHiddenWidgets } from './lib/hiddenWidgets.ts';
import { LightboxProvider } from './lib/lightbox.tsx';
import { useLightbox } from './lib/lightboxContext.ts';
import {
  sortByOrder,
  useBrokenOutPanels,
  usePanelOrder,
  usePinnedPanels,
  useWidePanels,
} from './lib/panelOrder.ts';
import { useTheme } from './lib/preferences.ts';
import { buildProjectRollups } from './lib/projectWidgets.ts';
import { clearScrollPosition, pruneScrollPositions } from './lib/scrollMemory.ts';
import { allocateSlots } from './lib/slotAllocator.ts';
import { startMemTelemetry } from './lib/telemetry.ts';
import { useAwaitingNotifications } from './lib/useAwaitingNotifications.ts';
import { useIdleDeferred, useUserActive } from './lib/useIdleDeferred.ts';
import { useIntentions } from './lib/useIntentions.ts';
import { PrefsProvider, usePrefs } from './lib/usePrefs.tsx';
import { withViewTransition } from './lib/viewTransition.ts';
import { worktreeColor } from './lib/worktree.ts';
import { groupByWorktreeKey, interleaveWorktreeSeparators } from './lib/worktreeGrouping.ts';
import { type ReplayInlineSource, type ReplaySource, ReplayView } from './ReplayView.tsx';
import { SelectorStoreProvider } from './transforms/selectors/store.tsx';
import { TraceProvider, useTraceStore } from './transforms/traceContext.tsx';
import { pruneToggles } from './transforms/useTransformToggles.ts';
import { trpc } from './trpc.ts';
import { type PanelState, useDeltaStream } from './useDeltaStream.ts';
import './app.css';

/** Topbar brand label. Picks once per app mount from a tiered pool — each
 * tier is `rarityFactor` times as likely as the previous, so common ≫
 * uncommon ≫ rare ≫ epic ≫ legendary. Items within a tier share the
 * tier's slice equally. Tweak `rarityFactor` below to make rare flavors
 * more or less common; reload the page to reroll. */
type Tier = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

const TIER_ORDER: Tier[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** How much rarer each tier is than the previous. 0.6 ⇒ each tier carries
 * 60% of the previous tier's total weight. */
const rarityFactor = 0.34;

const TIER_COLOR: Record<Tier, string> = {
  common: '#ffffff',
  uncommon: '#1eff00',
  rare: '#0070dd',
  epic: '#a335ee',
  legendary: '#ff8000',
};

const BRAND_OPTIONS: Array<{
  label: string;
  tier: Tier;
  ariaLabel?: string;
}> = [
  { label: '🧠🏠', tier: 'common', ariaLabel: 'brainhouse' },
  { label: 'Brainhouse', tier: 'common' },
  { label: '脑屋', tier: 'uncommon', ariaLabel: 'brainhouse (zh)' },
  { label: '/ˈbɹeɪnˌhaʊs/', tier: 'uncommon', ariaLabel: 'brainhouse (IPA)' },
  { label: 'Brejnhauß', tier: 'uncommon', ariaLabel: 'brainhouse (de?)' },
  { label: 'Cerebrodomus', tier: 'uncommon', ariaLabel: 'brainhouse (latinate)' },
  { label: 'B̸r̷a̴i̸n̵h̷o̴u̶s̷e̵', tier: 'rare', ariaLabel: 'brainhouse (zalgo)' },
  { label: '𝔅𝔯𝔞𝔦𝔫𝔥𝔬𝔲𝔰𝔢', tier: 'rare', ariaLabel: 'brainhouse (fraktur)' },
  { label: 'ǝsnoɥuᴉɐɹq', tier: 'epic', ariaLabel: 'brainhouse (upside-down)' },
  { label: 'ʙʀᴀɪɴʜᴏᴜsᴇ', tier: 'rare', ariaLabel: 'brainhouse (small caps)' },
  { label: '8®41nh0u$€', tier: 'epic', ariaLabel: 'brainhouse (hardcore leet)' },
  {
    label: 'B̸̢̧̧̛̛̗̬̘̪̳̮͙͍͚̲̾́̃̌̆͒̓̕͝͠͝r̷̢̛̛͙̠̥͙̗͔̘͕̦̆̔̃̅̑̇̌͐͒̉͝͝͠a̵̢̢̧̧̛̛̛̮̭̩̱̳̘͖̖̥̾̇̈́̆̏̌̏̕͝͠͝ĭ̶̧̢̛̛̪̭̪̳̩͔̭̄͑̃̾̏̕͝͝͝n̴̢̢̧̛̛̮̩͔͖̦̭̪̳͒̂̆̃̅̏̕͝͠h̷̢̛̛͉̫̬̗̳͖̬̳̆̌̾̅̃̆̕͝͝͠ơ̴̢̢̛̩̗̱̥̳̮̳̆̇̌̑̃̅̕͝͠ư̵̢̛̦͖̘̗̱̬̥̇̆̄̌̅̏̕͝͠s̶̢̛̛̪̩͔̬̳̆̇̌͒̕͝͠͝e̷̢̛̛̥̭̬͔̩͒̂̆̃̕͝͠͠',
    tier: 'epic',
    ariaLabel: 'brainhouse (corrupted)',
  },
  { label: "Brian's House", tier: 'rare', ariaLabel: 'brainhouse' },
  { label: "🙋🏻‍♂️'s 🏠", tier: 'rare', ariaLabel: "brian's house" },
  { label: "Brian's Horse", tier: 'legendary', ariaLabel: 'brainhouse' },
  { label: "🙋🏻‍♂️'s 🐴", tier: 'legendary', ariaLabel: "brian's horse" },
  { label: '#151 Mewtwo', tier: 'legendary', ariaLabel: 'brainhouse (mewtwo)' },
];

function weightFor(tier: Tier): number {
  // Tier total = rarityFactor^tierIndex. Per-item weight = tier total /
  // number of items in that tier (so within-tier choices are uniform).
  const idx = TIER_ORDER.indexOf(tier);
  const tierTotal = rarityFactor ** idx;
  const count = BRAND_OPTIONS.reduce((n, o) => n + (o.tier === tier ? 1 : 0), 0);
  return count === 0 ? 0 : tierTotal / count;
}

function pickBrand(): (typeof BRAND_OPTIONS)[number] {
  // Easter egg: when the wall-clock (12-hour, unpadded hour) is all the
  // same digit — 1:11, 2:22, 3:33, 4:44, 5:55, 11:11, each AM and PM —
  // flatten the distribution so every option is equally likely. Twelve
  // minutes a day where the gacha is suspended.
  const flat = isAllSameDigitMinute();
  const weights = flat ? BRAND_OPTIONS.map(() => 1) : BRAND_OPTIONS.map((o) => weightFor(o.tier));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < BRAND_OPTIONS.length; i++) {
    r -= weights[i] ?? 0;
    const opt = BRAND_OPTIONS[i];
    if (opt && r <= 0) return opt;
  }
  return BRAND_OPTIONS[0]!;
}

function isAllSameDigitMinute(now: Date = new Date()): boolean {
  // 12-hour, unpadded hour: 1:11 reads as "111" (3 chars), 11:11 as
  // "1111" (4). Check that every digit equals the first.
  const hour12 = now.getHours() % 12 || 12;
  const s = String(hour12) + String(now.getMinutes()).padStart(2, '0');
  for (const c of s) if (c !== s[0]) return false;
  return true;
}

// Picked once per page load — module-init scope so the topbar gradient
// and the brand label both see the same tier without prop-drilling.
const CURRENT_BRAND = pickBrand();

function BrandLabel() {
  const brand = CURRENT_BRAND;
  return (
    <span aria-label={brand.ariaLabel ?? brand.label} title={`brainhouse · ${brand.tier}`}>
      {brand.label}
    </span>
  );
}

export function App() {
  const replay = useReplayEntry();
  return (
    <PrefsProvider>
      <TraceProvider>{replay ? <ReplayView source={replay} /> : <AppMain />}</TraceProvider>
    </PrefsProvider>
  );
}

/** Read `?replay=<path>` once at mount and watch for drag-dropped
 * `.jsonl` files. Files become an inline replay source (browsers don't
 * expose absolute paths); the query-string form goes through the
 * allowlist-gated server loader. */
function useReplayEntry(): ReplaySource | ReplayInlineSource | null {
  const initial = (() => {
    const q = new URLSearchParams(window.location.search).get('replay');
    return q ? ({ kind: 'path', path: q } as ReplaySource) : null;
  })();
  const [source, setSource] = useState<ReplaySource | ReplayInlineSource | null>(initial);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        document.body.classList.add('replay-drop-target');
      }
    };
    const onDragLeave = (e: DragEvent) => {
      // Leaving the window — dataTransfer is null on the window-level leave.
      if (e.relatedTarget === null) document.body.classList.remove('replay-drop-target');
    };
    const onDrop = (e: DragEvent) => {
      document.body.classList.remove('replay-drop-target');
      const f = e.dataTransfer?.files?.[0];
      if (!f || !f.name.endsWith('.jsonl')) return;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        setSource({ kind: 'inline', label: f.name, contents: String(reader.result) });
      };
      reader.readAsText(f);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return source;
}

function AppMain() {
  const searchParams = new URLSearchParams(window.location.search);
  const freezeMode = searchParams.get('freeze') === '1';
  useEffect(() => {
    if (!freezeMode) return;
    document.body.setAttribute('data-freeze', '1');
    return () => document.body.removeAttribute('data-freeze');
  }, [freezeMode]);
  const { status, panels: allPanels } = useDeltaStream();
  const [theme, setTheme] = useTheme();
  const [processesPanelOpen, setProcessesPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('brainhouse:processesPanelOpen') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('brainhouse:processesPanelOpen', processesPanelOpen ? '1' : '0');
    } catch {}
  }, [processesPanelOpen]);
  const { prefs, refetch: refetchPrefs } = usePrefs();
  // Debug *mode* — the master dev-affordances switch. The ?debug query
  // param overrides the persisted prefs.debug.enabled flag (see
  // lib/debugMode.ts). Gates the topbar dev cluster, the uptime clock,
  // and the 🐛 panel-toggle button itself.
  const debugMode = debugEnabled(prefs.debug?.enabled);
  // Debug *panel* visibility — independent of mode. Only meaningful while
  // debugMode is on; the 🐛 button toggles it and it persists client-side.
  const [debugPanelOpen, setDebugPanelOpen] = useState<boolean>(loadPanelOpen);
  const toggleDebugPanel = () =>
    setDebugPanelOpen((open) => {
      const next = !open;
      savePanelOpen(next);
      return next;
    });
  useEffect(() => {
    if (!debugMode) return;
    document.body.setAttribute('data-debug', '1');
    return () => document.body.removeAttribute('data-debug');
  }, [debugMode]);
  // Memory telemetry: sample JS heap + DOM/element counts over time so the
  // multi-GB non-JS footprint creep can be charted. Debug-only; inspect via
  // window.__mem.dump(). See lib/telemetry.ts.
  useEffect(() => {
    if (!debugMode) return;
    return startMemTelemetry();
  }, [debugMode]);
  // Prune per-panel client state for sessions the server has fully
  // forgotten. The trace store, transform-toggle map, and scroll-memory
  // keys are each keyed by panel id and would otherwise grow for the life
  // of the tab — one entry per panel ever seen. Mirrors the prune pattern
  // in lib/hiddenPanels.ts. Keyed on the *unfiltered* allPanels set so a
  // blacklisted-but-still-live session keeps its state (unblacklisting
  // restores it without a reload).
  const traceStore = useTraceStore();
  useEffect(() => {
    const liveIds = new Set(allPanels.keys());
    traceStore.prune(liveIds);
    pruneToggles(liveIds);
    pruneScrollPositions(liveIds);
  }, [allPanels, traceStore]);

  // Filter out blacklisted session IDs before anything downstream touches
  // the panel set — that way every consumer (notifications, project
  // rollups, slot allocator, the grid/dock render trees) sees a
  // consistent reduced view, and unblacklisting (via PrefsModal) brings
  // panels back on the next refetch.
  const panels = useMemo(() => {
    const blocked = new Set(prefs.blacklist.sessionIds);
    if (blocked.size === 0) return allPanels;
    const out = new Map(allPanels);
    for (const id of blocked) out.delete(id);
    return out;
  }, [allPanels, prefs.blacklist.sessionIds]);

  // Idle-defer macro layout: while the user is interacting with the page,
  // hold the previous `panels` snapshot so the grid + project widgets
  // don't reflow under their cursor. Small-update consumers (per-row
  // content, notifications, click handlers) still see the live `panels`.
  const userActive = useUserActive((prefs.timings.layoutIdleSeconds ?? 0) * 1000);
  const stablePanels = useIdleDeferred(panels, userActive);
  useAwaitingNotifications(panels, prefs.notifications);

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
    prefs.roots
      .filter((r) => r.label && r.color)
      .map((r) => [r.label as string, r.color as string]),
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
  /** Putative drop position while a panel is being dragged over the grid.
   * `null` means "append at end"; otherwise the id of the panel the ghost
   * inserts before. Cleared on dragend/drop. */
  const [insertGhost, setInsertGhost] = useState<string | null | undefined>(undefined);
  const {
    dismiss,
    dismissAll,
    restore: restoreLocal,
    isHidden,
    isClientMini,
    isUserKept,
  } = usePanelDismissal(panels, {
    initial: seeded.dismissal,
    persist: (id, patch) => persistIntention(id, patch),
  });
  // Project-widget hide is sticky and lives OUTSIDE usePanelDismissal:
  // widget pseudo-ids (`project:<repo>`) are never real panel keys, so that
  // hook would prune them; and a widget's `last_event_at` advances with any
  // session activity, so its resurrection rule would undo the dismiss within
  // ~1s for an active project. We persist through the same `hidden_at`
  // column on the shared id namespace, but treat *presence* as hidden.
  const seededHiddenWidgets = useMemo(
    () =>
      new Set(
        Object.keys(seeded.dismissal.hiddenAt ?? {}).filter((id) => id.startsWith('project:')),
      ),
    [seeded.dismissal.hiddenAt],
  );
  const { hide: hideWidget, isHiddenWidget } = useHiddenWidgets({
    initial: seededHiddenWidgets,
    persist: (id, hidden) => persistIntention(id, { hidden_at: hidden ? Date.now() / 1000 : null }),
  });

  // Click on a subagent row dispatches this event; we mirror the
  // drop-from-nested branch of the grid drop handler so the affordance has
  // identical semantics to drag-to-promote. The detail can carry either a
  // resolved panel id, or a (parentId, description, agentType) tuple we
  // resolve against the full panels map — that fallback survives layout
  // filtering (clientMini / hidden) excluding the child from `subagents`.
  useEffect(() => {
    const onPromote = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          id?: string;
          parentId?: string;
          description?: string;
          agentType?: string | null;
        }>
      ).detail;
      let id = detail?.id ?? null;
      if (!id && detail?.parentId && detail?.description !== undefined) {
        for (const p of panels.values()) {
          if (p.kind !== 'subagent') continue;
          if (p.parent_panel_id !== detail.parentId) continue;
          if (p.task_description !== detail.description) continue;
          if (detail.agentType != null && p.agent_type !== detail.agentType) continue;
          id = p.id;
          break;
        }
      }
      if (!id) return;
      const srcPanel = panels.get(id);
      if (!srcPanel) return;
      withViewTransition(() => {
        if (!brokenOut.has(id)) toggleBrokenOut(id);
        if (isClientMini(srcPanel)) restoreLocal(id);
      });
    };
    window.addEventListener('brainhouse:promote-subagent', onPromote);
    return () => window.removeEventListener('brainhouse:promote-subagent', onPromote);
  }, [panels, brokenOut, toggleBrokenOut, isClientMini, restoreLocal]);

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
    document.documentElement.style.setProperty('--idle-opacity', String(prefs.display.idleOpacity));
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
    placeholdersByParent,
  } = layoutPanels(stablePanels, brokenOut);
  // Pinned panels always stay in the grid, never dim, never demote — they
  // override hidden / clientMini / server-mini routing.
  const isPinned = (p: PanelState) => pinned.has(p.id);

  // Subagents inside a parent's tray: user-intent filtering only — these
  // panels don't compete for top-level slots, so the allocator doesn't see
  // them.
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

  // Slot allocator: top-level placement is allocator-driven. User intents
  // (pin, dismiss, client-mini) always win — the allocator only sees panels
  // that have no explicit intent. Pinned panels claim slots unconditionally
  // (even past the cap); live unpinned next; then the allocator fills the
  // remaining slots from closed/idle panels via per-repo round-robin.
  const topLevel = [...allGridPanels, ...allTrayPanels];
  const allocatorInput = topLevel
    .filter((p) => isPinned(p) || isUserKept(p) || (!isHidden(p) && !isClientMini(p)))
    .map((p) => ({
      id: p.id,
      status: p.status,
      cwd: p.cwd ?? null,
      last_event_at: p.last_event_at,
    }));
  // The debug panel docks below the grid (see DebugDock) rather than
  // occupying a grid cell, so it no longer eats into the slot budget.
  const effectiveSlotCount = prefs.workspace.slotCount;
  // Manually-primary panels (user pulled them out of the dock) get the
  // same unconditional grid-slot treatment as pinned. Merging at the
  // call site keeps the allocator simple — it only knows "pinned".
  const allocatorPinned = new Set(pinned);
  for (const p of topLevel) {
    if (isUserKept(p)) allocatorPinned.add(p.id);
  }
  const allocation = allocateSlots(allocatorInput, allocatorPinned, effectiveSlotCount);

  const gridPanels: PanelState[] = [];
  const trayPanels: PanelState[] = [];
  const clientMiniPanels: PanelState[] = [];
  for (const p of topLevel) {
    if (!isPinned(p) && isHidden(p)) continue; // dropped entirely
    if (!isPinned(p) && isClientMini(p)) {
      clientMiniPanels.push(p);
      continue;
    }
    if (allocation.primary.has(p.id)) gridPanels.push(p);
    else trayPanels.push(p);
  }
  trayPanels.push(...clientMiniPanels, ...clientMiniSubs);
  // Sidebar order: most recently active first. The idle label on each
  // mini panel is anchored on last_event_at, so the sort key matches
  // what the user reads in the header — top row is freshest.
  trayPanels.sort((a, b) => b.last_event_at - a.last_event_at);
  // Lifecycle invariant: nothing in the main grid may carry server-mini
  // status. Mini is a sidebar-only lifecycle state. If allocator
  // backfill (or a pin/userKept override) lands a mini-status panel in
  // the grid, fire restore so the server flips it to `done` and the
  // panel renders as a full window. Idempotent on the server.
  useEffect(() => {
    for (const p of gridPanels) {
      if (p.status === 'mini') trpc.restore.mutate({ panelId: p.id });
    }
    // gridPanels reference changes every render; key on the id list so we
    // only re-fire when membership actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridPanels.map((p) => `${p.id}:${p.status}`).join(',')]);
  const orderedGridIds = sortByOrder(
    gridPanels.map((p) => p.id),
    order,
  );
  const baseOrderedGridPanels = orderedGridIds
    .map((id) => gridPanels.find((p) => p.id === id))
    .filter((p): p is PanelState => p !== undefined);
  // Group-by-worktree (prefs.workspace.groupByWorktree): stable-sort the
  // grid order so panels sharing a worktree key cluster together. Within
  // a group, the user's original ordering is preserved; "no worktree"
  // panels sink to the end. Visual separators are inserted at render
  // time below (see `gridRenderItems`).
  const orderedGridPanels = prefs.workspace.groupByWorktree
    ? groupByWorktreeKey(baseOrderedGridPanels)
    : baseOrderedGridPanels;

  // First-load auto-restore: if the snapshot lands with an empty grid but
  // there are live sessions sitting in the dock (e.g. all active panels
  // were previously dismissed and then the user reloaded), pull them back
  // out. Fires at most once per page load.
  const didAutoRestoreRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally one-shot; we don't want to refire on later state changes.
  useEffect(() => {
    if (didAutoRestoreRef.current) return;
    if (panels.size === 0) return;
    didAutoRestoreRef.current = true;
    if (orderedGridPanels.length > 0) return;
    const liveTray = trayPanels.filter((p) => p.status === 'live');
    if (liveTray.length === 0) return;
    withViewTransition(() => {
      for (const p of liveTray) {
        clearScrollPosition(p.id);
        const isClient =
          clientMiniPanels.some((m) => m.id === p.id) || clientMiniSubs.some((m) => m.id === p.id);
        if (isClient) restoreLocal(p.id);
        else trpc.restore.mutate({ panelId: p.id });
      }
    });
  }, [panels]);

  // Project widgets: one card per observed repo, with a rollup of
  // stats + recent sessions. Render after session cards in the grid.
  // Auto-derived from `panels` — not allocator-managed (widgets have
  // self-contained visibility rules, TBD).
  const allProjectRollups = buildProjectRollups(stablePanels).filter(
    // Sticky widget hide (see useHiddenWidgets) — presence means hidden,
    // independent of project activity, so dismissing an active project's
    // widget actually keeps it gone.
    (r) => !isHiddenWidget(r.widget.id),
  );
  // Widgets are *fill-only*: a true last resort. We render them only in
  // grid cells that no real session needs. Three subtractions go into
  // the budget:
  //   - the cells already consumed by grid panels (one each, plus an
  //     extra cell for every wide panel, since wide consumes two);
  //   - EVERY session parked in the dock, live or not. Any session in
  //     the tray — server-mini'd through idle-out, user-mini'd, or
  //     overflowed by the allocator — is real work the user can pull
  //     back at any moment, so it has a rightful claim on a cell and
  //     widgets must defer. A project widget is a synthesized aggregate;
  //     it's strictly a fallback for when no real session, gridded or
  //     parked, wants the space. (Earlier this counted only *live* tray
  //     panels, which let widgets preempt idle-but-valid parked
  //     sessions — the opposite of fallback.)
  //
  // A pinned widget (pseudo-id `project:<repo>`) always shows
  // regardless of the fill budget, mirroring how pinned session
  // panels work.
  const wideCountForBudget = orderedGridPanels.reduce((n, p) => n + (wide.has(p.id) ? 1 : 0), 0);
  // Count only TOP-LEVEL parked sessions: minimized subagents
  // (clientMiniSubs, appended onto trayPanels) live under a parent and
  // never claim a top-level cell, so they don't suppress widgets.
  const parkedSessionCount = trayPanels.length - clientMiniSubs.length;
  const widgetSlotBudget = Math.max(
    0,
    prefs.workspace.slotCount - orderedGridPanels.length - wideCountForBudget - parkedSessionCount,
  );
  const pinnedRollups: typeof allProjectRollups = [];
  const unpinnedRollups: typeof allProjectRollups = [];
  for (const r of allProjectRollups) {
    (pinned.has(r.widget.id) ? pinnedRollups : unpinnedRollups).push(r);
  }
  const projectRollups = [...pinnedRollups, ...unpinnedRollups.slice(0, widgetSlotBudget)];
  // Widgets past the grid fill budget land in a dock sub-strip rather than
  // disappearing entirely — clicking one promotes it (pins) back into the grid.
  const dockRollups = unpinnedRollups.slice(widgetSlotBudget);
  const openSessionFromWidget = (sessionId: string) => {
    const panel = panels.get(sessionId);
    if (!panel) {
      // Reaped/older session not in the live map — ask the server to parse its
      // transcript and re-surface it. The panel arrives via the delta stream
      // (panel_upsert), so fire-and-forget; the reducer mounts it.
      trpc.reopenSession.mutate({ sessionId }).catch(() => undefined);
      return;
    }
    // Clear *all* local dismissal intentions for this id —
    // `hidden_at`, `user_mini`, `auto_mini_at` — so a panel parked in
    // the dock OR fully hidden both return to the grid. The call is a
    // no-op if none of those flags are set.
    withViewTransition(() => {
      restoreLocal(sessionId);
      // Server-side mini panels need the server to step them back to
      // done so they re-allocate into a primary slot. `restore` ignores
      // ids that aren't mini, so it's safe to call regardless of the
      // local clear above.
      if (panel.status === 'mini') trpc.restore.mutate({ panelId: sessionId });
    });
    // Scroll into view once the next paint has the tile in the DOM.
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-panel-id="${sessionId}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // Wide panels consume two cells; everything else consumes one. We pass the
  // total slot count to the layout hook so a 4-panel grid with one wide panel
  // becomes a 5-slot tile (still picks a nice integer cols/rows). Mirrors
  // `wideCountForBudget` above — kept separate so each consumer is local.
  const wideCount = wideCountForBudget;
  const slots = orderedGridPanels.length + projectRollups.length + wideCount;
  const { ref: gridRef, cols, rows } = useGridLayout(slots);
  const gridStyle = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };

  const dockVisible = trayPanels.length > 0 || dockRollups.length > 0;

  return (
    <SelectorStoreProvider>
      <LightboxProvider>
        <LayoutGroup>
          <Layout
            slots={{
              top: (
                <>
                  <header
                    className="topbar"
                    style={
                      { '--brand-tier-color': TIER_COLOR[CURRENT_BRAND.tier] } as CSSProperties
                    }
                  >
                    <h1>
                      <BrandLabel />
                    </h1>
                    <span className="topbar-controls">
                      {/* Debug-only buttons clustered at the left so the cluster
                       * reads as one mode-switchable area; muted lime tint
                       * (--debug-color) reinforces the grouping. Neutral
                       * always-visible controls (clear all, stats) follow. */}
                      {debugMode && (
                        <>
                          <button
                            type="button"
                            className="debug-spawn is-debug-button"
                            onClick={() => trpc.debug.spawnMock.mutate()}
                          >
                            + mock session
                          </button>
                          <button
                            type="button"
                            className="debug-spawn is-debug-button"
                            onClick={() => trpc.debug.spawnCounter.mutate({ stopAt: 10 })}
                          >
                            + counter subagent
                          </button>
                          <ScenariosButton />
                          <TransformsButton />
                          <FlowsButton />
                          <UptimeClock />
                        </>
                      )}
                      <button type="button" className="debug-spawn" onClick={dismissAll}>
                        clear all
                      </button>
                      <StatsButton />
                      <HoverPopover
                        className={`conn conn-${status}`}
                        content={<ConnTooltip status={status} />}
                      >
                        <span>{status}</span>
                      </HoverPopover>
                      <span className="topbar-icon-buttons">
                        <button
                          type="button"
                          className="theme-toggle processes-toggle"
                          title={
                            processesPanelOpen ? 'Hide processes panel' : 'Show processes panel'
                          }
                          aria-pressed={processesPanelOpen}
                          onClick={() => setProcessesPanelOpen((v) => !v)}
                        >
                          ≡
                        </button>
                        {/* Panel toggle — only present in debug mode (set via prefs or
                         * ?debug). Shows/hides the debug panel without leaving debug
                         * mode; debug mode itself is owned by the prefs switch. */}
                        {debugMode && (
                          <button
                            type="button"
                            className="theme-toggle debug-toggle"
                            title={debugPanelOpen ? 'Hide debug panel' : 'Show debug panel'}
                            aria-label={debugPanelOpen ? 'Hide debug panel' : 'Show debug panel'}
                            aria-pressed={debugPanelOpen}
                            onClick={toggleDebugPanel}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="m8 2 1.88 1.88" />
                              <path d="M14.12 3.88 16 2" />
                              <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
                              <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
                              <path d="M12 20v-9" />
                              <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
                              <path d="M6 13H2" />
                              <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
                              <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
                              <path d="M22 13h-4" />
                              <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
                            </svg>
                          </button>
                        )}
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
                  {processesPanelOpen && (
                    <ProcessesPanel
                      allPanels={allPanels}
                      accountColorByLabel={accountColorByLabel}
                    />
                  )}
                </>
              ),
              main: (
                <div className="main-stack">
                  <main
                    className="session-grid"
                    ref={gridRef}
                    style={gridStyle}
                    onDragOver={(e) => {
                      onGridDragOver(e);
                      if (!e.dataTransfer.types.includes('text/brainhouse-panel')) return;
                      // Find the grid slot whose center is nearest the cursor, then
                      // decide before-or-after based on which half the cursor falls in.
                      const grid = e.currentTarget;
                      let nearest: HTMLElement | null = null;
                      let bestDist = Infinity;
                      for (const slot of grid.querySelectorAll<HTMLElement>('.grid-slot')) {
                        const r = slot.getBoundingClientRect();
                        const cx = r.left + r.width / 2;
                        const cy = r.top + r.height / 2;
                        const dx = e.clientX - cx;
                        const dy = e.clientY - cy;
                        const d2 = dx * dx + dy * dy;
                        if (d2 < bestDist) {
                          bestDist = d2;
                          nearest = slot;
                        }
                      }
                      if (!nearest) {
                        setInsertGhost(null);
                        return;
                      }
                      const r = nearest.getBoundingClientRect();
                      // First half → insert before; second half → insert after (i.e.
                      // before the next sibling, or append if none).
                      const beforeThis = e.clientX < r.left + r.width / 2;
                      if (beforeThis) {
                        setInsertGhost(nearest.dataset.panelId ?? null);
                      } else {
                        const next = nearest.nextElementSibling as HTMLElement | null;
                        setInsertGhost(next?.dataset?.panelId ?? null);
                      }
                    }}
                    onDragLeave={(e) => {
                      // Only clear when leaving the grid itself, not crossing into a
                      // child slot.
                      if (e.currentTarget === e.target) setInsertGhost(undefined);
                    }}
                    onDrop={(e) => {
                      setInsertGhost(undefined);
                      const id = e.dataTransfer.getData('text/brainhouse-panel');
                      if (!id) return;
                      const from = e.dataTransfer.getData('text/brainhouse-panel-source');
                      e.preventDefault();
                      // Drag-out from a parent's nested tray: break the subagent out
                      // onto the grid. If it was previously hidden/client-mini on the
                      // grid, also restore it so the drop is visible.
                      if (from === 'nested') {
                        const srcPanel = panels.get(id);
                        if (!srcPanel) return;
                        withViewTransition(() => {
                          if (!brokenOut.has(id)) toggleBrokenOut(id);
                          if (isClientMini(srcPanel)) restoreLocal(id);
                        });
                        return;
                      }
                      // Drag-out from dock to grid = "give this panel a slot."
                      // restoreLocal clears any dismiss intent + marks manually
                      // primary; for server-mini panels we also flip lifecycle.
                      withViewTransition(() => {
                        restoreLocal(id);
                        const srcPanel = panels.get(id);
                        if (srcPanel?.status === 'mini') {
                          trpc.restore.mutate({ panelId: id });
                        }
                      });
                    }}
                  >
                    <AnimatePresence initial={false}>
                      {interleaveWorktreeSeparators(
                        orderedGridPanels,
                        prefs.workspace.groupByWorktree,
                      ).map((item) =>
                        item.kind === 'separator' ? (
                          <div
                            key={`sep:${item.key}`}
                            className="worktree-group-separator"
                            style={{
                              ['--panel-worktree-color' as string]: worktreeColor(item.key),
                            }}
                          >
                            <span className="worktree-group-separator-swatch" aria-hidden="true" />
                            <span className="worktree-group-separator-label">{item.label}</span>
                          </div>
                        ) : (
                          <GridSlot
                            key={item.panel.id}
                            panel={item.panel}
                            insertBefore={insertGhost === item.panel.id}
                            subagents={subsByParent.get(item.panel.id) ?? []}
                            placeholders={placeholdersByParent.get(item.panel.id) ?? []}
                            panels={panels}
                            wide={wide.has(item.panel.id)}
                            pinned={pinned.has(item.panel.id)}
                            account={accountFor(item.panel)}
                            accountColor={accountColorFor(item.panel)}
                            accountFor={accountFor}
                            accountColorFor={accountColorFor}
                            onToggleWide={() => toggleWide(item.panel.id)}
                            onTogglePin={() => togglePin(item.panel.id)}
                            onTogglePinSub={(s) => togglePin(s.id)}
                            isPinnedSub={(s) => pinned.has(s.id)}
                            onHide={() => dismiss(item.panel)}
                            onHideSub={(s) => dismiss(s)}
                            brokenOutSubs={brokenOut}
                            onToggleBrokenOutSub={(s) => toggleBrokenOut(s.id)}
                            onReorder={(srcId) =>
                              moveBefore(
                                srcId,
                                item.panel.id,
                                orderedGridPanels.map((g) => g.id),
                              )
                            }
                          />
                        ),
                      )}
                    </AnimatePresence>
                    {insertGhost === null && orderedGridPanels.length > 0 && (
                      <div className="grid-slot insert-ghost-append" aria-hidden="true" />
                    )}
                    {projectRollups.map((r) => (
                      <div key={r.widget.id} className="grid-slot project-widget-slot">
                        <ProjectWidgetCard
                          rollup={r}
                          onOpenSession={openSessionFromWidget}
                          pinned={pinned.has(r.widget.id)}
                          onTogglePin={() => togglePin(r.widget.id)}
                          accountColor={
                            r.account_label ? accountColorByLabel.get(r.account_label) : undefined
                          }
                          onClose={() => {
                            // Unpin first: a widget promoted from the dock chip is
                            // pinned, and a pinned widget always claims a grid slot —
                            // leaving it pinned would keep resurrecting it on restore.
                            if (pinned.has(r.widget.id)) togglePin(r.widget.id);
                            hideWidget(r.widget.id);
                          }}
                        />
                      </div>
                    ))}
                    {orderedGridPanels.length === 0 &&
                      trayPanels.length === 0 &&
                      status === 'live' && (
                        <p className="empty">no sessions yet — try `+ mock session`</p>
                      )}
                  </main>
                  {debugMode && debugPanelOpen && (
                    <DebugDock>
                      <DebugTile
                        client={{
                          allPanels: panels,
                          gridIds: orderedGridPanels.map((p) => p.id),
                          dockIds: trayPanels.map((p) => p.id),
                          isHidden,
                          isClientMini,
                          isPinned: (id) => pinned.has(id),
                          isBrokenOut: (id) => brokenOut.has(id),
                        }}
                      />
                    </DebugDock>
                  )}
                </div>
              ),
              sidebar: dockVisible ? (
                <aside
                  className="session-dock"
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('text/brainhouse-panel')) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    (e.currentTarget as HTMLElement).classList.add('drop-target');
                  }}
                  onDragLeave={(e) =>
                    (e.currentTarget as HTMLElement).classList.remove('drop-target')
                  }
                  onDrop={(e) => {
                    (e.currentTarget as HTMLElement).classList.remove('drop-target');
                    const from = e.dataTransfer.getData('text/brainhouse-panel-source');
                    if (from !== 'nested') return; // grid→dock and dock→dock fall through to .session-grid restore
                    const id = e.dataTransfer.getData('text/brainhouse-panel');
                    const srcPanel = panels.get(id);
                    if (!srcPanel) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Break out of the parent's tray AND client-mini onto the dock.
                    withViewTransition(() => {
                      if (!brokenOut.has(id)) toggleBrokenOut(id);
                      if (!isClientMini(srcPanel)) dismiss(srcPanel);
                    });
                  }}
                >
                  <AnimatePresence initial={false}>
                    {trayPanels.map((p) => (
                      <MiniPanel
                        key={p.id}
                        panel={p}
                        onHide={() => dismiss(p)}
                        onRestore={() => {
                          // Restoring from the dock should always reveal a panel
                          // scrolled to the bottom — the user is bringing it back
                          // to catch up on what's happened. Wipe any stale
                          // sessionStorage scroll offset before the panel
                          // remounts so its useLayoutEffect snaps cleanly.
                          clearScrollPosition(p.id);
                          // Always mark manually-primary so the allocator gives
                          // this panel a grid slot. For server-mini panels we
                          // also flip the lifecycle state so the status dot
                          // reflects the user's intent.
                          withViewTransition(() => {
                            restoreLocal(p.id);
                            if (p.status === 'mini') {
                              trpc.restore.mutate({ panelId: p.id });
                            }
                          });
                        }}
                        pinned={pinned.has(p.id)}
                        onTogglePin={() => togglePin(p.id)}
                        onPinToMinibar={() => {
                          // TODO: real minibar pin semantics — see
                          // docs/superpowers/specs/2026-06-09-mini-hover-toolbar-design.md
                          console.info('[minibar pin] requested for', p.id);
                        }}
                        account={accountFor(p)}
                        accountColor={accountColorFor(p)}
                      />
                    ))}
                  </AnimatePresence>
                  {dockRollups.length > 0 && (
                    <div className="session-dock-projects">
                      <div className="session-dock-projects-label">projects</div>
                      {dockRollups.map((r) => (
                        <ProjectWidgetChip
                          key={r.widget.id}
                          rollup={r}
                          onPromote={() => togglePin(r.widget.id)}
                        />
                      ))}
                    </div>
                  )}
                </aside>
              ) : null,
            }}
          />
        </LayoutGroup>
      </LightboxProvider>
    </SelectorStoreProvider>
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
  insertBefore,
  subagents,
  placeholders,
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
  panels,
}: {
  panel: PanelState;
  insertBefore?: boolean;
  subagents: PanelState[];
  placeholders: PanelState[];
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
  panels: Map<string, PanelState>;
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
      className={classNames('grid-slot', wide && 'wide', insertBefore && 'insert-before')}
      data-panel-id={panel.id}
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
        setActiveDrag({
          id: panel.id,
          from: 'grid',
          parentId: panel.kind === 'subagent' ? panel.parent_panel_id : null,
          isBrokenOut: panel.kind === 'subagent',
        });
        (e.currentTarget as HTMLElement).classList.add('dragging');
      }}
      onDragEnd={(rawE) => {
        const e = rawE as unknown as React.DragEvent<HTMLDivElement>;
        (e.currentTarget as HTMLElement).classList.remove('dragging');
        setActiveDrag(null);
        setArmed(false);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/brainhouse-panel')) return;
        // Validate that THIS slot is a meaningful drop target for the
        // active drag. If not, let the event bubble to .session-grid which
        // handles the "anywhere on the grid" cases (break-out, restore).
        const el = e.currentTarget as HTMLElement;
        const drag = getActiveDrag();
        if (!drag) return;
        if (drag.from === 'nested') {
          // Nested-tray drag: drops land on the grid background, never on
          // an existing slot. Let bubble.
          return;
        }
        if (drag.from === 'grid' && drag.isBrokenOut) {
          // Broken-out subagent: the only valid grid-slot drop is its own
          // parent (re-dock). Drops on other slots fall through.
          if (panel.id !== drag.parentId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          el.classList.add('drop-target', 'redock-target');
          return;
        }
        // Regular grid panel: reorder against any other slot.
        if (drag.id === panel.id) return; // can't drop on self
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-target');
      }}
      onDragLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.classList.remove('drop-target');
        el.classList.remove('redock-target');
      }}
      onDrop={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.classList.remove('drop-target');
        el.classList.remove('redock-target');
        // Only consume the drop when we actually handle it; otherwise let
        // it bubble to .session-grid.
        const drag = getActiveDrag();
        if (!drag) return;
        const src = e.dataTransfer.getData('text/brainhouse-panel');
        if (!src) return;
        if (drag.from === 'grid' && drag.isBrokenOut) {
          if (panel.id !== drag.parentId) return;
          const srcPanel = panels.get(src);
          if (!srcPanel) return;
          e.preventDefault();
          e.stopPropagation();
          onToggleBrokenOutSub(srcPanel);
          return;
        }
        if (drag.from === 'grid' && !drag.isBrokenOut) {
          if (src === panel.id) return;
          e.preventDefault();
          e.stopPropagation();
          onReorder(src);
        }
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
        placeholders={placeholders}
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
        panels={panels}
      />
    </motion.div>
  );
}

function PanelWithSubagents({
  panel,
  subagents,
  placeholders,
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
  panels,
}: {
  panel: PanelState;
  subagents: PanelState[];
  placeholders: PanelState[];
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
  panels: Map<string, PanelState>;
}) {
  // Newest-first inside each status bucket so the most recently spawned
  // subagent sits at the top of the parent's nested tray.
  const byNewest = (a: PanelState, b: PanelState) => b.started_at - a.started_at;
  const live = subagents.filter((s) => s.status === 'live').sort(byNewest);
  const rest = subagents.filter((s) => s.status === 'done').sort(byNewest);
  // Breadcrumb only when this panel is a broken-out subagent — its parent
  // is somewhere else in the layout and the user might want to re-dock.
  const parentTitle =
    panel.kind === 'subagent' && brokenOutSubs.has(panel.id) && panel.parent_panel_id
      ? (panels.get(panel.parent_panel_id)?.title ?? null)
      : null;
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
        parentTitle={parentTitle}
        account={account}
        accountColor={accountColor}
        subagents={[...subagents, ...placeholders]}
      />
      {(live.length > 0 || rest.length > 0 || placeholders.length > 0) && (
        <div className="panel-subagents">
          {[...live, ...rest].map((s) => (
            <NestedSubagentSlot key={s.id} panel={s}>
              <PanelCard
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
            </NestedSubagentSlot>
          ))}
          {placeholders.map((s) => (
            <SubagentPlaceholder key={s.id} panel={s} onRedock={() => onToggleBrokenOutSub(s)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Thin wrapper around a nested subagent's PanelCard that arms native
 * HTML5 drag from the panel header. Drop targets (.session-grid, .session-dock,
 * and other grid panels) consume the `text/brainhouse-panel` + source='nested'
 * payload to break the subagent out of its parent's tray. */
function NestedSubagentSlot({ panel, children }: { panel: PanelState; children: React.ReactNode }) {
  const [armed, setArmed] = useState(false);
  return (
    <div
      className="nested-subagent-slot"
      draggable={armed}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        const inHeader = !!t.closest('.panel-header');
        const onButton = !!t.closest('button');
        setArmed(inHeader && !onButton);
      }}
      onMouseUp={() => setArmed(false)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/brainhouse-panel', panel.id);
        e.dataTransfer.setData('text/brainhouse-panel-source', 'nested');
        setActiveDrag({
          id: panel.id,
          from: 'nested',
          parentId: panel.parent_panel_id,
          isBrokenOut: false,
        });
        (e.currentTarget as HTMLElement).classList.add('dragging');
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).classList.remove('dragging');
        setActiveDrag(null);
        setArmed(false);
      }}
    >
      {children}
    </div>
  );
}

/** Thin tray row representing a subagent that's been pulled out into the
 * grid/dock. Mirrors the live panel's status so the user sees its state
 * without leaving the parent. Click to re-dock (alternative to dragging
 * the detached panel back onto the parent). */
function SubagentPlaceholder({ panel, onRedock }: { panel: PanelState; onRedock: () => void }) {
  return (
    <button
      type="button"
      className={classNames(
        'subagent-placeholder',
        `status-${panel.status}`,
        panel.ended && 'ended',
      )}
      onClick={onRedock}
      title="Re-dock into this session"
    >
      <span className="subagent-placeholder-status" aria-hidden="true" />
      <span className="subagent-placeholder-title">{panel.title || panel.id}</span>
      <span className="subagent-placeholder-redock" aria-hidden="true">
        ↩
      </span>
    </button>
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
  onPinToMinibar,
}: {
  panel: PanelState;
  onHide: () => void;
  onRestore: () => void;
  account: string | null | undefined;
  accountColor: string | undefined;
  pinned: boolean;
  onTogglePin: () => void;
  onPinToMinibar: () => void;
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
        // Use the inner .panel article (not the motion.div wrapper) for the
        // drag image. framer-motion's `layout` prop applies live CSS
        // transforms to the wrapper during enter/exit/reorder, and those
        // transforms confuse the browser's snapshot — it ends up grabbing
        // sibling mini-panel content within the wrapper's transformed
        // bounding box. The inner article has no transforms applied.
        const wrapper = e.currentTarget as HTMLElement;
        const inner = wrapper.querySelector<HTMLElement>('.panel');
        const dragImg = inner ?? wrapper;
        const r = dragImg.getBoundingClientRect();
        e.dataTransfer.setDragImage(dragImg, e.clientX - r.left, e.clientY - r.top);
      }}
    >
      <PanelCard
        panel={panel}
        onHide={onHide}
        onRestore={onRestore}
        onPinToMinibar={onPinToMinibar}
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
      className="debug-spawn is-debug-button"
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
      className="debug-spawn is-debug-button"
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
      className="debug-spawn is-debug-button"
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
}: {
  prefs: import('./lib/usePrefs.tsx').ClientPrefs;
  onSaved?: () => void;
}) {
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
  /** Broken-out subagents grouped by parent. The parent's tray renders a
   * thin placeholder row for each so the user can see what's been pulled
   * out and re-dock it. The full panel still lives in gridPanels/trayPanels
   * by its own status — the placeholder is purely a tray-side breadcrumb. */
  placeholdersByParent: Map<string, PanelState[]>;
}

function layoutPanels(panels: Map<string, PanelState>, brokenOut: Set<string>): Layout {
  const all = Array.from(panels.values());
  const subsByParent = new Map<string, PanelState[]>();
  const placeholdersByParent = new Map<string, PanelState[]>();
  for (const p of all) {
    if (p.kind !== 'subagent' || !p.parent_panel_id || !panels.has(p.parent_panel_id)) continue;
    const target = brokenOut.has(p.id) ? placeholdersByParent : subsByParent;
    const arr = target.get(p.parent_panel_id) ?? [];
    arr.push(p);
    target.set(p.parent_panel_id, arr);
  }
  const gridPanels: PanelState[] = [];
  const trayPanels: PanelState[] = [];
  for (const p of all) {
    if (p.kind === 'parent') {
      if (p.status === 'mini') trayPanels.push(p);
      else gridPanels.push(p);
    } else if (p.parent_panel_id == null || !panels.has(p.parent_panel_id) || brokenOut.has(p.id)) {
      // Orphan subagent OR one the user has explicitly broken out: place
      // by its own status, top-level.
      if (p.status === 'mini') trayPanels.push(p);
      else gridPanels.push(p);
    }
    // Otherwise the subagent renders inside its parent's nested tray via subsByParent.
  }
  return { gridPanels, trayPanels, subsByParent, placeholdersByParent };
}
