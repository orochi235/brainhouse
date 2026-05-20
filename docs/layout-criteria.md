# Brainhouse — layout encoding criteria

What panel placement should communicate, beyond "panels fit on screen." These
are not options to pick between — they're the design pressures the layout
needs to balance. Whatever metaphor we land on (grid, semi-physical, zones,
hybrid) has to answer each of these.

## 1. Recency / activity drift

A user glancing at the wall should be able to find the chatty session in O(1).
The most-recently-active panel pulls toward a fixed corner (top-left in
Western reading order); idle panels drift toward the opposite corner.

Currently implicit in the lifecycle (`live → done → mini → removed`), but the
*grid ordering itself* is purely manual + first-arrival. Promoting
`last_event_at` to a default sort key (with manual drag still authoritative)
would make activity visually answerable without having to read each panel's
timer.

## 2. Parent–child clustering / spatial provenance

Subagents render inside their parent's nested tray today. The intuition we
want to extend: when a subagent pops *out* of its parent (grows large, gets
pinned, gets dragged to a slot of its own), the animation should originate
from the parent's position so the user feels the lineage instead of having
the new panel materialize in some arbitrary grid slot. Same principle in
reverse when a subagent goes back into the tray.

## 3. Status zones

Implicit zones in the grid: `live` panels gravitate to the top half,
`done`/`mini` to the bottom. Panels migrate between zones as they transition.
Not a hard grid divider — more like two grids stacked with smooth animation
across the boundary, so the eye learns "above the fold = happening now."

## 4. Heat / activity halo

Position-encoding has limits — at some grid size you can't keep moving
panels around without losing scanability. Visual weight (glow, border
saturation, slight pulse cadence) encodes activity *in place*, at the panel
level, when re-positioning would be too noisy. Already partially done via
`waiting-pulse` and `.status-live` styling; could extend to "events per
minute" → glow intensity.

## 5. Cluster density per `cwd`

Group panels with the same `cwd` near each other via a subtle gap-collapse
(panels in the same project sit slightly closer). Encodes "these belong
together" without needing an explicit visual group, and avoids the
edges-and-arrows clutter that a pure graph view would impose.

---

## Why this list

Anything we build on the layout side (animations, sort keys, zones,
gravitational pulls between related panels) should be checked against this
list. If a change makes one criterion stronger at the cost of another, that's
a real trade-off worth surfacing in the commit message and a design note —
not silently making (1) better while breaking (5).
