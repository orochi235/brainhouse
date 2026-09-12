# Handoff — windease support for a rebuilt brainhouse UI

For whoever picks up the brainhouse UI rewrite. Records what was established
about the layout library underneath it and the UI decisions made along the
way. No brainhouse code was written. Three windease gaps found here were
fixed and merged — see *Shipped* below.

**The question actually being answered:** whether windease supports the kind
of dashboard brainhouse wants — one that rearranges itself constantly, with
items sized by importance. Answer: yes, and closer to off-the-shelf than
expected. The UI design was a means of testing that, and stalled deliberately
(see *What landed last*).

## windease: what's already there

`gridStrategy` is the fit. The mapping is direct:

- **Priority → `childOrder`.** Items lay out in order.
- **Importance → `placement.span`** (cell counts, not pixels).
- **Voids fill themselves.** `reserveCells` (`src/layout/grid.ts:163`) is
  first-fit row-major: each item takes the first free block it fits, so a
  later small item backfills the hole a big one left. No masonry pass needed.
- **Capacity is native.** `maxRows`/`maxItems` push the remainder to
  `unplaced`, which a host can simply not render.
- **Reordering animates for free.** `Container` transitions
  `left/top/width/height` at `settleMs` (`src/react/Container.tsx:427`),
  auto-zeroed during affordance drags and under `prefers-reduced-motion`.
- **Pinning is native and outranks everything** in cell reservation
  (`grid.ts:152`).

Anti-thrash levers, all in `ThrottlePolicy` (`src/throttle.ts:36`):
`stagger: { batch, ms }` drips resettles when many items become eligible at
once — the most valuable one for a busy wall; `notifyMs` coalesces write
bursts per frame; `dwell` gates lifecycle/transit/focus transitions.

**What windease does not have:** coordinate placement. There is no `(col,
row)` placement key — position is order, and `span` is the only per-item
placement input. `TODO.md:67` puts fixed cells behind unbuilt variable-cell
layout. Fine for a system-arranged dashboard; wrong tool for a
user-parks-tiles canvas.

## Copy `~/src/portfolio`, not the 1.0 client

`src/components/TileWorkspace.tsx` + `src/lib/tileLayout.ts` are a working
precedent for exactly this shape — one `gridStrategy` container, one flat
`childOrder`. Four things to lift:

- **Register once, never unregister.** Filtering is `hideNode`/`showNode`, so
  `childOrder` is never rewritten and DOM identity (an iframe, a video)
  survives a filter change. This is also most of the answer to layout thrash.
- **Responsive column policy** (`tileLayout.ts:31`) — forced columns below
  breakpoints, `maxCols` above, auto-balance choosing. **Trap:** the store
  deletes only config keys handed to it as `undefined`, so an omitted `cols`
  lingers from the previous patch. Always pass every key.
- **`useSyncExternalStore` + a by-value signature string** to make the item
  list settle.
- **`settleMs` gated on a motion mode** — the lever for "the effects aren't
  worth what we pay."

**The one hack, now obsolete.** `planTileGrid` runs `gridStrategy.layout()`
twice — once at a throwaway `PROBE_HEIGHT` to discover the row count, then for
real — because windease lays into a fixed viewport and the grid would not
report its tiling. `gridTiling` (below) does now, so that probe is dead code
waiting to be removed. It was a *content-sized grid* problem either way: panes
wanting content sizing use `hints.sizing.h`, which brainhouse's shell already
does for the topbar and processes widget (`client/src/layout/store.ts`), and
the design below has no content-sized grid at all.

## Shipped

Three windease fixes landed on `main` (`e05f672`, unpushed) while establishing
the above:

- **`gridTiling(items, options)`** returns the columns and rows a config
  produces, with no container and no layout pass — grid resolves its whole
  tiling before it ever reads the container. **Portfolio's probe in
  `planTileGrid` can now be deleted**; that is a live follow-up, not done.
- **`LayoutStrategy.configConflicts`** — `ContainerHost` now traces keys that
  cancel each other and keys another key's branch never reads. Grid declares
  five; `cols` silently killing `maxCols`, `rows` and `orientation` used to be
  invisible.
- **`updateContainerConfig` compares by value**, so a host recomputing config
  from a `ResizeObserver` no longer emits and notifies on every tick.

## UI direction agreed (provisional)

Diagnosis of 1.0: too much on screen at once — dock, `top`-like widget, and
eight transcripts. Also too heavy, and the glow effects don't earn their cost.
Stated priorities, in order: *is anything waiting for me right now*; see
timely artifacts without opening Preview and losing focus; timeliness over
per-session conversation flow.

Shell, as a re-slotting of the existing nested strips in
`client/src/layout/store.ts` — not a new mechanism:

```
┌─────────────────────────────────────┐
│ topbar                    (sizing.h)│  root strip, axis y
├─────────────────────────────────────┤
│ attention band            (sizing.h)│  hidden when empty
├──────────────────────┬──────────────┤
│    priority grid     │  artifacts   │  workarea strip, axis x
│                      │   column     │  ← draggable seam
└──────────────────────┴──────────────┘
```

- The band is a new root-strip pane, `hideNode`'d when nothing waits — so
  "is anything waiting" is answerable peripherally, by whether it's there.
- The sidebar pane becomes the artifacts column, keeping its `hints.maxSize`
  cap and its seam.
- The processes widget stops being a pane and becomes a pinned tile in the
  grid. That deletes the `main-area` strip level.
- **The dock is deleted.** Overflow is not rendered; finding old work moves
  to search.

Mechanisms that survive regardless of what the items turn out to be: capacity
expressed as `maxRows` derived from a minimum legible cell height rather than
an arbitrary N; asymmetric hysteresis on rank boundaries (promote instantly,
demote only after the condition holds) — windease's `dwell` is keyed to its
own machines, so this is brainhouse's own pure function.

## What landed last, and what it invalidates

**Jobs are the currency, not sessions. One session can have content in more
than one band.** The rank model drafted before this was session-keyed and
one-card-per-session, including a decision that a session in the band is
promoted out of the grid. All of that needs redoing against jobs. What a job
is, how it's derived from a transcript, and its lifecycle are undefined and
are the first thing to settle.

## Decomposition

Four specs, in this order. Option 2's arrangement was chosen partly because
the later ones can land into an empty region without blocking the shell.

1. **Shell + attention model + priority grid** — blocked on the job model.
2. **Artifact surfacing** — extract every artifact a session produces, store
   it, render it inline. The largest piece, and the thing most wanted.
3. **Search + recently-closed** — what makes deleting the dock safe.
4. **Job model** — listed last but blocks (1); may belong inside it.

## Traps

- Both repos are on `main`. windease has the fixes committed and **unpushed**
  (9 commits ahead of origin, 8 of them predating this work). brainhouse has
  a large uncommitted working tree that is **not** from this work — only
  `HANDOFF.md` and two `.gitignore` lines are.
- Another session commits to windease concurrently; `main` moved mid-session.
- Brainstorm mockups are in `.superpowers/brainstorm/` (added to
  `.gitignore` this session). `sections.html` and `regions.html` show the
  options that were chosen between.
- Both chezmoi trees have an unpushed commit from this session (a status-line
  handoff badge, unrelated to the above): `~/.local/share/chezmoi` `13b1713`
  and `~/.local/share/chezmoi-pw` `f51bfa6`.
- brainhouse runs windease 1.3; portfolio pins `^1.2.1`. Check before
  assuming a pattern transfers.
