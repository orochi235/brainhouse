# Mini-transition → sidebar — design

Date: 2026-06-09
Status: approved

## Problem

When the server transitions a panel to `mini` (idle long enough that
its lifecycle steps `live → done → mini`), the slot allocator can still
backfill it into the main grid because of the round-robin "fill empty
slots from idle panels" rule. The user expects an immediate visible
move to the sidebar the moment the panel goes mini, with the panel
popping back to the grid only when fresh activity arrives.

## Approach

Re-use the existing `autoMiniAt` intent inside `usePanelDismissal`:

- `autoMiniAt[id] = ts` records "this panel was auto-routed to the dock
  at `ts`."
- The `isClientMini(panel)` check returns true while
  `panel.last_event_at <= autoMiniAt[panel.id]`. The first event after
  the stamp lifts the routing automatically.
- The slot allocator already excludes `isClientMini` panels from
  primary placement.

So a server-driven mini transition only needs to write an `autoMiniAt`
stamp at the moment the transition is observed on the client.

## Implementation

`client/src/lib/hiddenPanels.ts`:

- Add a `prevStatusRef = useRef(new Map<string, PanelStatus>())` to
  the hook.
- Add a `useEffect` that, on every change to `panels`, walks the panel
  map. For each entry:
  - Look up the previous status from `prevStatusRef.current`.
  - If `prev` is `'live'` or `'done'` AND `p.status === 'mini'`, set
    `autoMiniAt[p.id] = Math.max(p.last_event_at, now)` and call
    `persist?.(p.id, { auto_mini_at: ... })`.
  - Update `prevStatusRef.current.set(p.id, p.status)` for the next
    pass.
- Prune `prevStatusRef.current` entries when a panel is removed (same
  pass used to prune the other intent maps).

Edge cases:

- **Already-mini on first sight** (bootstrap replay): no prior status
  is recorded, so this branch doesn't fire. Bootstrap's existing
  stale-on-first-sight auto-mini still handles those.
- **User-pinned panels**: the allocator overrides `isClientMini` for
  pinned ids, so a pinned panel stays in the grid even if its status
  flips to mini.
- **User-kept panels (`userKept`)**: similarly override `isClientMini`
  via the allocator. A user-kept panel that transitions to mini stays
  on the grid until the user dismisses it again.
- **Restored via the existing `restore` path**: the `userKept` intent
  is set and `autoMiniAt[id]` is cleared, so the next mini transition
  would re-fire the auto-mini stamp normally.

## Persistence

The `persist` callback (already wired to a tRPC mutation that stores
intent in localStorage / server state) is called the same way as the
existing first-sight auto-mini stamp. No new persistence schema.

## Tests

`client/src/lib/hiddenPanels.test.tsx`:

1. Panel transitions `live → mini` while the hook is mounted → next
   render, `isClientMini(panel)` returns true.
2. Same transition, then `last_event_at` advances past the stamp →
   `isClientMini(panel)` returns false again.
3. Panel arrives already in `mini` state (no prior observation) →
   stamp NOT applied by the transition hook (bootstrap stale-on-sight
   still applies independently).
4. `done → mini` transition also stamps.
5. `live → done` (no mini) → no stamp.

## Failure modes

- **Hook fires before panels prop is stable**: tracked via the same
  `useEffect` dependency on `panels`. Each render's new-status read is
  authoritative; the previous map is only used to detect the diff.
- **Persist callback throws**: same swallowing pattern as the existing
  first-sight stamp (best-effort persist; in-memory state is canonical
  for the session).

## Out of scope

- The sidebar's "+3h" timestamp display bug — investigated separately.
- Any change to how the user manually dismisses panels (`dismiss`
  path is unaffected).
- Animations / view transitions for the move — already covered by
  `withViewTransition` wrappers elsewhere; this change just flips the
  intent flag.
