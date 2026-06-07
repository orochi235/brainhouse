/**
 * Top-level layout shell. Mounts the windease providers and a single
 * `NodeContainer` rooted at the binarySplit root zone. The container
 * fills the viewport; everything beneath is positioned by binarySplit's
 * pixel rects, with drag-y / drag-x affordances at each gutter.
 */
import { binarySplit, gridStrategy, stackStrategy } from 'windease';
import {
  Container,
  StrategyRegistryProvider,
  WindeaseProvider,
} from 'windease/react';
import { useEffect } from 'react';
import { layoutChrome, type Slots, SlotsProvider } from './chrome.tsx';
import { layoutStore, ROOT_ID, WORKAREA_ID } from './store.ts';

const SIDEBAR_MAX_PX = 400;
/** Hard floor so a too-short measurement (e.g. ProcessesPanel mid-load
 * with no rows yet) doesn't pin the gutter on top of the topbar. */
const TOP_MIN_PX = 48;

const strategies = {
  binarySplit,
  grid: gridStrategy,
  stack: stackStrategy,
};

export interface LayoutProps {
  slots: Slots;
}

export function Layout({ slots }: LayoutProps) {
  // On first paint, shrink the top section to fit its actual content
  // (topbar + ProcessesPanel-if-open) instead of the default ratio.
  // Children of `.layout-slot-top` are non-flex-stretching, so their
  // offsetHeight reflects natural height.
  //
  // Re-fits via ResizeObserver while content is still settling
  // (ProcessesPanel rows stream in async after the subscription
  // connects). Stops the first time something other than this hook
  // changes the root ratio — once the user drags the gutter, they
  // own the size.
  useEffect(() => {
    const slot = document.querySelector<HTMLElement>('.layout-slot-top');
    if (!slot) return;

    let active = true;
    let lastApplied: number | null = null;

    const fit = () => {
      if (!active) return;
      const vh = window.innerHeight;
      if (vh <= 0) return;
      // Sum the children's TRUE natural heights:
      // - Topbar (and any other simple block): offsetHeight is fine.
      // - ProcessesPanel: it's `flex: 1 1 auto`, so its own offsetHeight /
      //   scrollHeight both report the *box* size assigned by flex (the
      //   slot height minus the topbar) — that's a circular reading.
      //   The panel's natural size lives in its inner pieces: the
      //   header chrome + the table itself, which are unstretched.
      let naturalH = 0;
      for (const c of Array.from(slot.children)) {
        const el = c as HTMLElement;
        if (el.classList.contains('processes-panel')) {
          // Read the panel's intrinsic content, not its flex-stretched box.
          const header = el.querySelector<HTMLElement>(':scope > header');
          const table = el.querySelector<HTMLElement>(':scope > table');
          const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
          const padBot = parseFloat(getComputedStyle(el).paddingBottom) || 0;
          const marTop = parseFloat(getComputedStyle(el).marginTop) || 0;
          const marBot = parseFloat(getComputedStyle(el).marginBottom) || 0;
          naturalH +=
            (header?.offsetHeight ?? 0) +
            (table?.offsetHeight ?? 0) +
            padTop + padBot + marTop + marBot;
        } else {
          naturalH += el.offsetHeight;
        }
      }
      if (naturalH <= 0) return; // children not yet laid out
      const target = Math.max(TOP_MIN_PX, naturalH);
      const ratio = Math.min(0.95, target / vh);
      lastApplied = ratio;
      layoutStore.setContainerState(ROOT_ID, { ratio });
    };

    // Stop refitting the moment user (or anyone else) changes the ratio
    // to a value we didn't write — that's a manual drag.
    const off = layoutStore.events.on('container.stateChanged', (e) => {
      if (e.id !== ROOT_ID) return;
      const to = (e.to as { ratio?: number } | undefined)?.ratio;
      if (to === undefined || lastApplied === null) return;
      if (Math.abs(to - lastApplied) > 1e-6) active = false;
    });

    // ResizeObserver covers the topbar growing (e.g. font swap). For
    // the ProcessesPanel we watch its subtree (rows arriving don't
    // change the panel's outer box, only its scrollHeight), so a
    // separate MutationObserver picks those up.
    const ro = new ResizeObserver(() => fit());
    for (const child of Array.from(slot.children)) ro.observe(child);

    const contentMo = new MutationObserver(() => fit());
    const observePanel = () => {
      const panel = slot.querySelector('.processes-panel');
      if (panel) contentMo.observe(panel, { childList: true, subtree: true });
    };
    observePanel();

    // Children may be added/removed (ProcessesPanel toggle on/off).
    const structureMo = new MutationObserver(() => {
      for (const child of Array.from(slot.children)) ro.observe(child);
      contentMo.disconnect();
      observePanel();
      fit();
    });
    structureMo.observe(slot, { childList: true });

    fit();

    return () => {
      active = false;
      ro.disconnect();
      contentMo.disconnect();
      structureMo.disconnect();
      off();
    };
  }, []);

  // windease's binarySplit only supports minSize hints — there's no
  // maxSize yet. Clamp the workarea ratio on every viewport resize so
  // the sidebar (1 - ratio) * width never exceeds SIDEBAR_MAX_PX. When
  // windease ships maxSize support this hook goes away in favor of a
  // hints.maxSize on the sidebar slot.
  useEffect(() => {
    const apply = () => {
      const w = window.innerWidth;
      if (w <= 0) return;
      const minRatio = 1 - SIDEBAR_MAX_PX / w;
      const current = (layoutStore.getContainerState(WORKAREA_ID) as { ratio: number } | undefined)
        ?.ratio ?? 0.8;
      if (current < minRatio - 1e-6) {
        layoutStore.setContainerState(WORKAREA_ID, { ratio: minRatio });
      }
    };
    apply();
    window.addEventListener('resize', apply);
    // Also clamp on user drag of the gutter — the container.stateChanged
    // event fires after every binarySplit reduce(). Guard against the
    // re-entrant setContainerState (apply → stateChanged → apply) by
    // only writing when out of bounds (the ε in `apply` above).
    const off = layoutStore.events.on('container.stateChanged', (e) => {
      if (e.id === WORKAREA_ID) apply();
    });
    return () => {
      window.removeEventListener('resize', apply);
      off();
    };
  }, []);

  return (
    <WindeaseProvider store={layoutStore}>
      <StrategyRegistryProvider strategies={strategies}>
        <SlotsProvider value={slots}>
          <Container
            parentId={ROOT_ID}
            chrome={layoutChrome}
            affordances
            className="layout-root"
          />
        </SlotsProvider>
      </StrategyRegistryProvider>
    </WindeaseProvider>
  );
}
