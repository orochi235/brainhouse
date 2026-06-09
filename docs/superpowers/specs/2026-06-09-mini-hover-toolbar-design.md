# Mini Hover Toolbar — Design

**Status:** Approved 2026-06-09

## Goal

Give mini-mode panels in the sidebar tray a hover-revealed action toolbar
with three primary actions: restore to grid, pin to minibar, and remove.

## User experience

- A mini-row panel in the tray shows no extra chrome by default.
- On mouse-enter of the row, a flat toolbar slides up from the row's
  bottom edge, overlaying the bottom strip of the panel.
- On mouse-leave, the toolbar slides back down and disappears behind the
  row's bottom edge.
- The toolbar spans the full width of the mini row, divided into three
  equal segments — each a flat colored rectangle with a centered white
  SVG glyph.

## Visual spec

| Segment  | Background | Glyph                                                                       |
| -------- | ---------- | --------------------------------------------------------------------------- |
| Restore  | Green      | A "U" rotated so the opening faces 9:00, with an arrowhead on the top end.  |
| Pin      | Crimson    | Existing pin glyph used elsewhere in PanelCard.                              |
| Trash    | Gray       | New trash-can SVG.                                                          |

- Toolbar height: ~22–26px, flush to the panel's bottom edge.
- Slide transition: ~150ms ease-out, `transform: translateY(100% → 0)`
  plus opacity 0 → 1. Reversed on hover-off.
- Toolbar is clipped by the panel's existing `overflow: hidden`, so
  hidden state requires no extra masking.

### Restore glyph construction

The arrow is a custom SVG, not from any icon library. Construction:

- A stroked arc forming a "U" whose opening faces left (9 o'clock).
- A small arrowhead (chevron) on the upper terminus of the arc, pointing
  away from the arc's center along the tangent.
- White stroke on the colored background.

## Behavior

- Buttons must `stopPropagation` so clicks do not bubble into the
  existing mini-row click handler (PanelCard.tsx:723) which calls
  `onRestore`.
- Restore button → calls existing `onRestore` prop.
- Trash button → calls existing `onHide` prop.
- Pin button → calls new `onPinToMinibar` prop.
- A button whose corresponding prop is not provided is rendered disabled
  (or omitted) — but in the mini-tray render path all three are
  expected.

## Scope deferred

The semantics of "pinned to the minibar" — eviction immunity, sort
priority, persistence across sessions — are out of scope for this spec.
This change delivers the UI and wires `onPinToMinibar` to a stub in
`App.tsx`. A follow-up spec will define minibar pin state.

## Files touched

- `client/src/components/MiniHoverToolbar.tsx` — new component. Contains
  the toolbar markup and the three inline SVG glyphs.
- `client/src/components/PanelCard.tsx` — render `<MiniHoverToolbar>`
  inside the mini variant (around line 486+). Plumb new
  `onPinToMinibar` prop.
- `client/src/app.css` — `.mini-hover-toolbar`, `.mini-hover-toolbar__btn`,
  per-action color classes, slide transition, hover trigger on the mini
  row.
- `client/src/App.tsx` — pass an `onPinToMinibar` stub (logs / no-op)
  through to mini-mode panels.

## Testing

- Unit: render a mini PanelCard with all three handlers; assert buttons
  exist, each click invokes its handler exactly once, and clicks do not
  invoke the row-level restore handler.
- Manual: verify slide-in/out on hover; verify click targets do not
  collide with the row-click restore.
