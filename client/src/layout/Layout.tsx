/**
 * Top-level layout shell. Mounts the windease providers and a single
 * `NodeContainer` rooted at the binarySplit root zone. The container
 * fills the viewport; everything beneath is positioned by binarySplit's
 * pixel rects, with drag-y / drag-x affordances at each gutter.
 */
import { gridStrategy, splitStrategy, stackStrategy } from 'windease';
import {
  Container,
  Provider,
  StrategyRegistryProvider,
} from 'windease/react';
import { useEffect } from 'react';
import { layoutChrome, type Slots, SlotsProvider } from './chrome.tsx';
import { computeTopRatio, type FitState, nextFitRatio } from './fit.ts';
import { layoutStore, ROOT_ID, setSplitRatio, WORKAREA_ID } from './store.ts';

const SIDEBAR_MAX_PX = 400;
/** Hard floor so a too-short measurement (e.g. ProcessesPanel mid-load
 * with no rows yet) doesn't pin the gutter on top of the topbar. */
const TOP_MIN_PX = 48;
/** Cap the top at this fraction of the viewport so a long process list
 * scrolls inside ProcessesPanel instead of eating the workspace below. */
const TOP_MAX_FRACTION = 0.4;

const strategies = {
  // 0.6 renamed binarySplit → splitStrategy (binary by default). The registry
  // key stays 'binarySplit' since store.ts nodes reference it by that id and
  // our layout stays strictly two-children-per-level.
  binarySplit: splitStrategy,
  grid: gridStrategy,
  stack: stackStrategy,
};

export interface LayoutProps {
  slots: Slots;
}

export function Layout({ slots }: LayoutProps) {
  // Keep the top section sized to its actual content (topbar +
  // ProcessesPanel-if-open) by writing the root binarySplit ratio. The
  // top's children don't flex-grow vertically, so their offsetHeights are
  // intrinsic; we sum those to get the natural height and convert it to a
  // ratio (clamped to [TOP_MIN_PX, TOP_MAX_FRACTION] — see fit.ts).
  //
  // Three things made earlier versions fail and are handled here:
  //  1. The slot is mounted by a nested windease Container that may not
  //     exist when this effect first runs — so we retry across frames
  //     until it appears instead of bailing forever (which left the slot
  //     stuck at the default ratio).
  //  2. ProcessesPanel is `flex: 1` and stretches to the slot, so observing
  //     ITS box re-fires on our own writes (and fights a manual drag). We
  //     observe the unstretched inner pieces (topbar, panel header/table)
  //     instead, which only change on real content changes.
  //  3. ratio is a viewport fraction, so it must be recomputed on window
  //     resize.
  // Stops refitting the first time the ratio changes to a value we didn't
  // write — that's a manual drag, and the user now owns the size.
  useEffect(() => {
    let active = true;
    let fitState: FitState = { last: null, prev: null };
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;

    const measure = (slot: HTMLElement): number => {
      let naturalH = 0;
      for (const c of Array.from(slot.children)) {
        const el = c as HTMLElement;
        if (el.classList.contains('processes-panel')) {
          // Intrinsic content = sum of the panel's (unstretched) children
          // plus the panel's own box chrome. Robust to header+table vs
          // header+empty-state, and not circular with the flex-stretched box.
          const cs = getComputedStyle(el);
          const chrome =
            (parseFloat(cs.paddingTop) || 0) +
            (parseFloat(cs.paddingBottom) || 0) +
            (parseFloat(cs.marginTop) || 0) +
            (parseFloat(cs.marginBottom) || 0) +
            (parseFloat(cs.borderTopWidth) || 0) +
            (parseFloat(cs.borderBottomWidth) || 0);
          let inner = 0;
          for (const piece of Array.from(el.children)) inner += (piece as HTMLElement).offsetHeight;
          naturalH += inner + chrome;
        } else {
          naturalH += el.offsetHeight;
        }
      }
      return naturalH;
    };

    const fit = () => {
      if (!active) return;
      const slot = document.querySelector<HTMLElement>('.layout-slot-top');
      if (!slot) return;
      const ratio = computeTopRatio(measure(slot), window.innerHeight, {
        minPx: TOP_MIN_PX,
        maxFraction: TOP_MAX_FRACTION,
      });
      if (ratio === null) return;
      // Gate the write through the stability helper: skips sub-pixel rewrites
      // and damps the wrap-induced two-value oscillation (see nextFitRatio).
      const { apply, state } = nextFitRatio(fitState, ratio, 0.5 / window.innerHeight);
      fitState = state;
      if (apply === null) return;
      setSplitRatio(ROOT_ID, apply);
    };

    // Observe the unstretched inner pieces (not the flex-stretched panel
    // box), re-targeting whenever the slot's subtree changes.
    const reobserve = (slot: HTMLElement) => {
      ro?.disconnect();
      for (const c of Array.from(slot.children)) {
        const el = c as HTMLElement;
        if (el.classList.contains('processes-panel')) {
          for (const piece of Array.from(el.children)) ro?.observe(piece as Element);
        } else {
          ro?.observe(el);
        }
      }
    };

    const attach = () => {
      const slot = document.querySelector<HTMLElement>('.layout-slot-top');
      if (!slot) {
        raf = requestAnimationFrame(attach);
        return;
      }
      let hadPanel = !!slot.querySelector('.processes-panel');
      ro = new ResizeObserver(() => fit());
      mo = new MutationObserver(() => {
        // Toggling the ProcessesPanel on/off is a structural content
        // change, not a content-size tweak: any prior manual gutter drag
        // (which parked `active` at false) no longer applies. Re-arm the
        // auto-fit and clear its history so the top resizes to the new
        // content — otherwise a stale ratio leaves a dead gap below the
        // topbar when the panel is off (or clips it on the next resize).
        const hasPanel = !!slot.querySelector('.processes-panel');
        if (hasPanel !== hadPanel) {
          hadPanel = hasPanel;
          active = true;
          fitState = { last: null, prev: null };
        }
        reobserve(slot);
        fit();
      });
      reobserve(slot);
      mo.observe(slot, { childList: true, subtree: true });
      fit();
    };

    // Stop refitting the moment the ratio changes to a value we didn't
    // write — that's a manual drag.
    const off = layoutStore.events.on('container.stateChanged', (e) => {
      if (e.id !== ROOT_ID) return;
      const to = (e.to as { ratio?: number } | undefined)?.ratio;
      if (to === undefined || fitState.last === null) return;
      if (Math.abs(to - fitState.last) > 1e-6) active = false;
    });

    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    attach();

    return () => {
      active = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', onResize);
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
        setSplitRatio(WORKAREA_ID, minRatio);
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
    <Provider store={layoutStore}>
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
    </Provider>
  );
}
