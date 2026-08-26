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
  // Keep the top section sized to the topbar's natural height by writing
  // the root binarySplit ratio (clamped to [TOP_MIN_PX,
  // TOP_MAX_FRACTION] — see fit.ts).
  //
  // Two things made earlier versions fail and are handled here:
  //  1. The slot is mounted by a nested windease Container that may not
  //     exist when this effect first runs — so we retry across frames
  //     until it appears instead of bailing forever (which left the slot
  //     stuck at the default ratio).
  //  2. ratio is a viewport fraction, so it must be recomputed on window
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
      for (const c of Array.from(slot.children)) naturalH += (c as HTMLElement).offsetHeight;
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

    const reobserve = (slot: HTMLElement) => {
      ro?.disconnect();
      for (const c of Array.from(slot.children)) ro?.observe(c);
    };

    const attach = () => {
      const slot = document.querySelector<HTMLElement>('.layout-slot-top');
      if (!slot) {
        raf = requestAnimationFrame(attach);
        return;
      }
      ro = new ResizeObserver(() => fit());
      mo = new MutationObserver(() => {
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
