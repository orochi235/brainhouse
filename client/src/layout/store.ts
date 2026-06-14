/**
 * Top-level windease layout store.
 *
 * Two binary splits: root splits vertically into `top` and `workarea`;
 * workarea splits horizontally into `main` and `sidebar`. Each terminal
 * slot is a single `Panel` whose `meta.slot` keys into the `Slots`
 * record App.tsx supplies. The binarySplit strategy emits drag-x /
 * drag-y affordances for each gutter, which `NodeContainer` renders as
 * resize handles.
 *
 *     ┌───────────────────────────┐
 *     │           top             │  ← root binarySplit (vertical)
 *     ├═══════════════════════════┤    drag-y resize gutter
 *     │     main      │  sidebar  │  ← workarea binarySplit (horizontal)
 *     └───────────────┴───────────┘    drag-x resize gutter between
 *
 * All slots stay in `visible` lifecycle — binarySplit requires exactly
 * two visible children at each level. Empty content (e.g. no dock) is
 * App.tsx's job to render as a null panel body, not the store's job to
 * collapse the rect.
 */
import {
  asNodeId,
  createGroup,
  createPanel,
  createZone,
  type NodeId,
  type SplitNode,
  Store,
} from 'windease';

export const ROOT_ID = asNodeId('root');
export const WORKAREA_ID = asNodeId('workarea');
export const TOP_SLOT_ID = asNodeId('top-slot');
export const MAIN_SLOT_ID = asNodeId('main-slot');
export const SIDEBAR_SLOT_ID = asNodeId('sidebar-slot');

export type SlotId =
  | typeof TOP_SLOT_ID
  | typeof MAIN_SLOT_ID
  | typeof SIDEBAR_SLOT_ID;

function buildStore(): Store {
  const store = new Store();

  // Root: vertical split. Small initial ratio so the topbar starts
  // close to its natural ~50px height. minSize on the top slot keeps a
  // floor; user can drag the gutter to grow it.
  store.registerNode(
    createZone({
      id: ROOT_ID,
      strategyId: 'binarySplit',
      config: { direction: 'vertical', gutterSize: 4 },
    }),
  );
  store.registerNode(
    createPanel({
      id: TOP_SLOT_ID,
      parentId: ROOT_ID,
      meta: { slot: 'top' },
      hints: { minSize: { w: 0, h: 36 } },
    }),
  );
  store.registerNode(
    createGroup({
      id: WORKAREA_ID,
      parentId: ROOT_ID,
      strategyId: 'binarySplit',
      config: { direction: 'horizontal', gutterSize: 4 },
    }),
  );

  // Workarea: horizontal split. Initial ratio puts main at ~80% and
  // sidebar at ~20%. minSize on each so the gutter can't pinch a side
  // to nothing.
  store.registerNode(
    createPanel({
      id: MAIN_SLOT_ID,
      parentId: WORKAREA_ID,
      meta: { slot: 'main' },
      hints: { minSize: { w: 240, h: 0 } },
    }),
  );
  store.registerNode(
    createPanel({
      id: SIDEBAR_SLOT_ID,
      parentId: WORKAREA_ID,
      meta: { slot: 'sidebar' },
      hints: { minSize: { w: 220, h: 0 } },
    }),
  );

  // Everything renders. binarySplit needs 2 visible children per level.
  store.showNode(TOP_SLOT_ID);
  store.showNode(WORKAREA_ID);
  store.showNode(MAIN_SLOT_ID);
  store.showNode(SIDEBAR_SLOT_ID);

  // Seed each container's splitStrategy state with an explicit SplitNode
  // tree. Two reasons this must be explicit rather than relying on the
  // strategy's initialState():
  //   1. initialState() hardcodes a *horizontal* root split, but the root
  //      must split vertically (top above workarea).
  //   2. it seeds the non-default initial ratios so the first paint matches
  //      intent instead of the strategy's 0.5 default.
  // Top hosts the topbar plus the ProcessesPanel when open — give it enough
  // vertical space for a few process rows by default.
  store.setContainerState(ROOT_ID, {
    kind: 'split',
    direction: 'vertical',
    ratio: 0.28,
    a: { kind: 'leaf', id: TOP_SLOT_ID },
    b: { kind: 'leaf', id: WORKAREA_ID },
  } satisfies SplitNode);
  store.setContainerState(WORKAREA_ID, {
    kind: 'split',
    direction: 'horizontal',
    ratio: 0.8,
    a: { kind: 'leaf', id: MAIN_SLOT_ID },
    b: { kind: 'leaf', id: SIDEBAR_SLOT_ID },
  } satisfies SplitNode);
  return store;
}

/** Update only the top-level ratio of a container's SplitNode state,
 * preserving the rest of the tree. windease 0.6's splitStrategy stores its
 * state as a SplitNode (ratio lives inside the tree), so callers that want
 * to nudge the gutter must splice the ratio in rather than overwrite the
 * state with a bare `{ ratio }` (which the strategy's tree-walk would
 * dereference as a malformed split node and crash). */
export function setSplitRatio(id: NodeId, ratio: number): void {
  const cur = layoutStore.getContainerState(id) as SplitNode | undefined;
  if (!cur || cur.kind !== 'split') return;
  layoutStore.setContainerState(id, { ...cur, ratio });
}

export const layoutStore = buildStore();

export function setSlotVisible(id: NodeId, visible: boolean): void {
  const state = layoutStore.getNode(id)?.lifecycle.state;
  if (visible) {
    if (state !== 'visible') layoutStore.showNode(id);
    return;
  }
  if (state === 'mounted') layoutStore.showNode(id);
  if (layoutStore.getNode(id)?.lifecycle.state === 'visible') {
    layoutStore.hideNode(id);
  }
}
