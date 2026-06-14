# Active-band grid ordering

## Problem

Today the grid renders panels in `topLevel` order (`[...allGridPanels,
...allTrayPanels]`), where each block iterates `panels` Map in insertion
order and the split between blocks is driven by current status (`mini`
vs. not). When a panel transitions out of `mini` and back, it pops back
into its Map-order position — which may be *earlier* than other live
panels' positions — and the grid visibly reshuffles.

Two consistently-active panels do not swap from update events alone, but
status flicks (live↔done↔mini around the idle/awaiting/Stop transitions)
do cause visible swaps. The user wants the grid order to stay stable
across activity transients.

## Goal

Render the grid in a stable "active band" order:

- A panel claims a band slot when it first enters primary placement
  (allocator's `primary` set).
- Once in the band, its position never moves due to activity, status
  flicks, or allocator opinion changes.
- A panel exits the band only after it has been overflow-eligible for
  a grace period (no longer in allocator's primary). Rapid status
  flicks don't kick it out; sustained absence does.
- Re-entering after a real exit is a new entry — appended at the end.
- Manual drag adjusts a panel's band-entry order (no separate
  `manual_order` layer — the band IS the order).

## Architecture

### New hook: `useBandOrder`

```ts
function useBandOrder(
  primaryIds: ReadonlySet<string>,
  graceMs: number,
  initialOrder?: Map<string, number>,
  persist?: (id: string, entryOrder: number | null) => void,
): { order: string[]; moveBefore: (sourceId: string, targetId: string) => void };
```

Owns a single internal map:

```ts
bandRef = useRef(new Map<string, { entryTime: number; exitSince: number | null }>())
```

`entryTime` is monotonic; new entries get `max(existing) + 1`. The
absolute value doesn't matter, only the relative ordering.

### Lifecycle, called every render

Given the current `primaryIds` set, run a pure function `stepBand`:

1. For each id in `primaryIds`:
   - If id ∉ band → insert with `entryTime = (max existing entryTime) + 1`
     (or `0` if band is empty), `exitSince = null`. Mark as a new entrant
     so the caller can persist its initial `entryOrder`.
   - Else if id ∈ band and `exitSince != null` → clear `exitSince`.
     The panel came back during grace; keep its position.
2. For each id ∈ band but not in `primaryIds`:
   - If `exitSince == null` → set `exitSince = now`.
   - Else if `now - exitSince >= graceMs` → remove from band entirely.
3. Sort remaining band entries by `entryTime` asc; return as `order`.

This may briefly produce a band larger than `slotCount` during grace
(a panel pending exit + a fresh entrant both in the band). The grid's
auto-fit handles it without UI breakage.

### Implementation note: grace timer

`stepBand` is synchronous and depends on `now`. The hook also needs a
`setTimeout` to re-run after `graceMs` so panels eventually exit even
if no other state change triggers a re-render. Internally:

```ts
useEffect(() => {
  const earliestExit = ...compute from bandRef...;
  if (earliestExit === null) return;
  const ms = Math.max(0, earliestExit + graceMs - Date.now());
  const t = setTimeout(() => forceUpdate(), ms);
  return () => clearTimeout(t);
}, [bandRef.current, graceMs]);
```

Where `forceUpdate` is a `useReducer((x) => x + 1, 0)` increment to
trigger a re-render that re-evaluates the band.

### `moveBefore` drag handler

```ts
moveBefore(sourceId, targetId): void {
  const source = bandRef.current.get(sourceId);
  const target = bandRef.current.get(targetId);
  if (!source || !target) return;
  // Insert source just before target by giving it an entryTime slightly
  // less than target's. Float values are fine; we don't compact unless
  // collisions arise.
  source.entryTime = target.entryTime - 0.5;
  // Optional: renormalize entire band to consecutive integers and
  // persist via `persist(id, newOrder)`. Renormalize on drag end so
  // float drift stays bounded.
  renormalizeBand(bandRef.current, persist);
}
```

`renormalizeBand` walks band entries sorted by `entryTime` and reassigns
`entryTime = 0, 1, 2, …`. Calls `persist(id, newOrder)` for any id whose
order changed, so the intentions table stays in sync.

### Persistence: reuse `manual_order` intention

The existing `manual_order` intention already serializes a panel
ordering and persists across reloads. We repurpose it as the band
entry order:

- On first hydration from `useIntentions().seeded.order`, copy
  `manual_order[id]` into `entryTime[id]` for each panel currently in
  primary. Panels in primary without a saved order get appended via
  the standard `max+1` rule.
- `persist(id, entryOrder)` writes through to `manual_order`.
- `usePanelOrder` is deleted; `App.tsx` calls `useBandOrder` instead.

The migration is invisible: a user's existing `manual_order` simply
becomes their initial band entry order.

### Caller wiring in `App.tsx`

Replace:

```ts
const { order, moveBefore } = usePanelOrder({ ... });
// ...
const orderedGridIds = sortByOrder(gridPanels.map(p => p.id), order);
```

With:

```ts
const { order: bandOrder, moveBefore } = useBandOrder(
  allocation.primary,
  prefs.timings.miniSeconds * 1000,
  seeded.order,
  (id, entryOrder) => persistIntention(id, { manual_order: entryOrder }),
);
const orderedGridPanels = bandOrder
  .map((id) => stablePanels.get(id))
  .filter((p): p is PanelState => p !== undefined);
```

The `groupByWorktreeKey` wrapping stays: it stable-sorts the band order
by repo while preserving within-group order.

### Tray composition

Tray panels = `topLevel` minus the band. Today the tray includes:
1. Allocator overflow (allocator put them in tray)
2. `clientMiniPanels` (user-mini'd)
3. `clientMiniSubs` (user-mini'd subagents)

After the change, tray = (anything in `topLevel` not in `bandOrder`) +
`clientMiniSubs`. The "client mini" and "allocator overflow" cases both
result in the panel not being in `bandOrder` (allocator never picked
them; or it picked them but grace expired and they got dropped).

The "live tray panels reserve grid slots" widget-budget logic
(`liveTrayCount`) stays correct — a live panel only ends up in the
tray if it was deliberately user-mini'd, which already had a "rightful
slot claim" semantic.

### Constants

- `graceMs = prefs.timings.miniSeconds * 1000`. Semantically: "this
  panel has been idle long enough for the server to mini it." Same
  threshold the server already uses to demote a panel; reusing it
  keeps band behavior aligned with server-side lifecycle without a
  new pref.

## Testing

Unit tests for `stepBand` (pure function):

- Empty band + 3 panels in primary → all entered in deterministic
  order (call sequence determines entryTime).
- Panel exits primary → still in band with `exitSince` set; band
  unchanged in order.
- Panel re-enters primary within grace → `exitSince` cleared; order
  preserved.
- Panel out of primary past graceMs → removed from band.
- New entrant while another is in grace → appended to end; band size
  temporarily exceeds slotCount.
- Drag: `moveBefore(A, B)` rewrites entryTime so A < B; subsequent
  step preserves the order.
- Renormalize after drag produces consecutive integers and calls
  persist for changed ids only.

Integration test in `App.tsx` flow:

- Initial render with seeded intentions → band order matches
  intentions.
- Status flick (live→done→live) on one panel → no order change.
- Status flick longer than graceMs → panel exits band, re-entering
  appends at end.
- Drag reorder → persists, survives a remount.

## Migration / rollout

No data migration. The hook reads existing `manual_order` intentions
on first hydration; behavior is backwards-compatible.

## Non-goals

- Cross-session bandwidth (per-user, per-machine, per-window): the
  band is per-page-instance. Reload starts fresh and re-seeds from
  intentions.
- A "freeze the band entirely" mode (no auto entries/exits at all).
  If we want this later, it's a toggle on the hook.
- Different grace periods per status transition. One threshold covers
  all overflow reasons.

## Open question (resolved)

> "Should `graceMs` reuse `prefs.timings.miniSeconds` or get its own
> pref?"

**Reuse `miniSeconds`.** Semantically aligned and the user doesn't have
to think about two thresholds.
