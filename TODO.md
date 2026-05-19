# brainhouse — project todos

## Multi-account support
Surface sessions from more than one Claude config root at the same time (e.g. `~/.claude` *and* `~/.claude-pw`). Watcher already accepts multiple roots; needs config plumbing, per-account tagging in the panel header, and visual distinction (badge / border color).

## Coalesce file ops into "file-change" events
Ideally, all Read + Edit + Write operations on the same file within a short
window (a few seconds, say) collapse into a single `file-change` view item in
the transcript. The capsule shows the file path + a short summary (lines
added/removed) inline; clicking it opens the lightbox showing a real **diff**
across the window — the before/after of all the edits stacked together. This
removes the N-capsule clutter and gives the actually-interesting signal
(the diff) a proper place to live.

Implement in `client/src/lib/pipeline.ts` as a new transform branch alongside
`mergeToolResultIntoCapsule` etc. Diff rendering can use `diff` or
`diff-match-patch` in the lightbox renderer.

## Minimize visual weight of pure-read ops
Read, Glob, Grep, and similar lookups that don't change state should render at
a reduced footprint (smaller row, lower contrast, maybe collapsed) so that
state-changing ops (Edit, Write, Bash-with-side-effects, external API calls)
read as the dominant signal. Note: once Read is folded into the file-change
coalescing above, only the lookups that don't touch a file (Glob, Grep,
WebFetch, WebSearch) remain in scope here.

## Log state recovery on refresh
When the page reloads, we currently re-subscribe to the deltas stream and get
a fresh snapshot, but client-side view state (scroll positions inside panels,
which panel was being read, which lightbox was open, etc.) is lost. Wire a
per-panel `lastViewedAt` + scroll offset into localStorage so a refresh feels
seamless instead of "back to the top of every transcript."

## Session window drag-to-resize
Real tiling: drag edges/corners of a panel to give it more grid cells.
Persist the resize per panel id alongside the existing `wide` set (it would
generalize `wide` to arbitrary col/row spans). Needs grid-line snapping + a
small handle UI, plus a way to express "this panel spans 2 cols × 3 rows"
in the layout state.

## Tiled window management
Replace the auto-fill grid with a tiling layout: drag panels into slots, resize between rows, persist layout per project. Likely needs a dedicated layout state in `App.tsx` and a thin manager component.

## Schema / pipeline buildout
Continue extending `preprocessEvents` to interpret newer record types as Claude Code adds them. Inventory current passthrough `meta` records (we already saw `custom-title`, `agent-name`, `subagent-meta`, `permission-mode`, `agent-color`, `pr-link`, `queue-operation`, `file-history-snapshot`, `attachment`, `last-prompt`) and decide which deserve first-class rendering.
