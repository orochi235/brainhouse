/**
 * Top-level windease layout store.
 *
 * Three nested strips. Root stacks the topbar over the workarea; the
 * workarea puts the main column beside the sidebar; the main column
 * stacks the top widget over the session grid. Each terminal slot is a
 * leaf whose `meta.slot` keys into the `Slots` record App.tsx supplies,
 * and every strip emits a draggable seam between its children.
 *
 *     ┌───────────────────────────┐
 *     │           top             │  ← root strip (axis y)
 *     ├───────────────────────────┤
 *     │  processes    │           │  ← main strip (axis y)
 *     ├───────────────┤  sidebar  │    seam between widget and grid
 *     │     grid      │           │  ← workarea strip (axis x)
 *     └───────────────┴───────────┘
 *
 * Sizing is declarative: the topbar and the top widget ask to be sized by
 * their content (`hints.sizing.h`), the sidebar caps its width with
 * `hints.maxSize`, and everything else shares the remainder. A seam drag
 * writes `placement.size` and from then on that pane is pinned — which is
 * what "the user now owns this size" means here.
 */
import { asNodeId, createNode, type NodeId, Store } from 'windease';

export const ROOT_ID = asNodeId('root');
export const WORKAREA_ID = asNodeId('workarea');
export const MAIN_AREA_ID = asNodeId('main-area');
export const TOP_SLOT_ID = asNodeId('top-slot');
export const PROCESSES_SLOT_ID = asNodeId('processes-slot');
export const MAIN_SLOT_ID = asNodeId('main-slot');
export const SIDEBAR_SLOT_ID = asNodeId('sidebar-slot');

export type SlotId =
  | typeof TOP_SLOT_ID
  | typeof PROCESSES_SLOT_ID
  | typeof MAIN_SLOT_ID
  | typeof SIDEBAR_SLOT_ID;

/** Wide enough that only the axis being capped actually binds. */
const UNCAPPED = 1e6;
const SIDEBAR_MAX_W = 400;
const SIDEBAR_DEFAULT_W = 320;
/** Opening height of the top widget — a few rows. Dragging its seam
 * replaces this for the rest of the session. */
const PROCESSES_DEFAULT_H = 300;

function strip(axis: 'x' | 'y', resizable = true) {
  return {
    strategyId: 'strip',
    // `neighbor` is splitter behavior: the seam moves the pair it sits
    // between and leaves every other pane where it is.
    config: { axis, fill: true, gap: 4, resizeMode: 'neighbor' as const, resizable },
  };
}

function buildStore(): Store {
  // notifyMs coalesces write bursts (resize, seam drag) into one flush per
  // frame. No dwell: every lifecycle transition on this store is a direct
  // user action, where debounce latency only hurts.
  const store = new Store({ throttle: { notifyMs: 16 } });

  store.registerNode(createNode({ id: ROOT_ID, kind: 'zone', container: strip('y', false) }));
  store.registerNode(
    createNode({
      id: TOP_SLOT_ID,
      kind: 'panel',
      parentId: ROOT_ID,
      focus: true,
      meta: { slot: 'top' },
      hints: { sizing: { h: 'content' }, minSize: { w: 0, h: 36 } },
    }),
  );
  store.registerNode(
    createNode({ id: WORKAREA_ID, kind: 'group', parentId: ROOT_ID, container: strip('x') }),
  );

  store.registerNode(
    createNode({
      id: MAIN_AREA_ID,
      kind: 'group',
      parentId: WORKAREA_ID,
      container: strip('y'),
    }),
  );
  store.registerNode(
    createNode({
      id: SIDEBAR_SLOT_ID,
      kind: 'panel',
      parentId: WORKAREA_ID,
      focus: true,
      meta: { slot: 'sidebar' },
      // Stated, not shared: strip only clamps a row to `maxSize` when some
      // child in it states a size, so a pure-fill row would split the
      // viewport in half and ignore the cap entirely.
      placement: { size: { w: SIDEBAR_DEFAULT_W } },
      hints: {
        minSize: { w: 220, h: 0 },
        maxSize: { w: SIDEBAR_MAX_W, h: UNCAPPED },
      },
    }),
  );

  store.registerNode(
    createNode({
      id: PROCESSES_SLOT_ID,
      kind: 'panel',
      parentId: MAIN_AREA_ID,
      focus: true,
      meta: { slot: 'processes' },
      // A stated size, not a measurement: the panel scrolls internally, so
      // it has to fill whatever extent the pane has — and a measured pane
      // is wrapped in an auto-height box that no percentage height can
      // resolve against. The seam overwrites this the first time it moves.
      placement: { size: { h: PROCESSES_DEFAULT_H } },
      hints: { minSize: { w: 0, h: 80 } },
    }),
  );
  store.registerNode(
    createNode({
      id: MAIN_SLOT_ID,
      kind: 'panel',
      parentId: MAIN_AREA_ID,
      focus: true,
      meta: { slot: 'main' },
      hints: { minSize: { w: 240, h: 120 } },
    }),
  );

  store.showNode(TOP_SLOT_ID);
  store.showNode(WORKAREA_ID);
  store.showNode(MAIN_AREA_ID);
  store.showNode(MAIN_SLOT_ID);
  store.showNode(SIDEBAR_SLOT_ID);
  // The widget starts hidden; App.tsx shows it from its own persisted
  // toggle. A hidden child is left out of the strip entirely, so the grid
  // gets the whole column and no seam is drawn for it.
  return store;
}

export const layoutStore = buildStore();

/**
 * Show or hide the top widget, keeping the grid honest either way.
 *
 * A seam drag pins both panes it moves, so the grid is left carrying a
 * stated height that no longer means anything once the widget is gone —
 * it would hold that height and leave a gap where the widget was.
 * Clearing it puts the grid back to sharing the column.
 */
export function setProcessesVisible(visible: boolean): void {
  layoutStore.transact(() => {
    setSlotVisible(PROCESSES_SLOT_ID, visible);
    layoutStore.patchPlacement(MAIN_SLOT_ID, { size: { h: undefined } });
  }, 'processes-visibility');
}

export function setSlotVisible(id: NodeId, visible: boolean): void {
  // Truth reads, not getNode: under a throttle policy the published view
  // lags, and deciding an FSM transition off a stale state silently
  // drops or doubles the transition.
  const state = layoutStore.getNodeTruth(id)?.lifecycle.state;
  if (visible) {
    if (state !== 'visible') layoutStore.showNode(id);
    return;
  }
  if (state === 'mounted') layoutStore.showNode(id);
  if (layoutStore.getNodeTruth(id)?.lifecycle.state === 'visible') {
    layoutStore.hideNode(id);
  }
}
