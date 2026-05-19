# UI component taxonomy

## Exported components

| File | Exports | Role |
|---|---|---|
| `client/src/App.tsx` | `App` | top-level shell, topbar, grid, mini-tray |
| `client/src/components/PanelCard.tsx` | `PanelCard` | one session card (header + body) |
| `client/src/components/EventList.tsx` | `EventList`, `EventTime` | renders one panel's preprocessed view items |
| `client/src/components/ToolCapsule.tsx` | `ToolCapsule` | one tool_use/result row |
| `client/src/components/Markdown.tsx` | `Markdown` | sanitized GFM + hljs renderer |
| `client/src/lib/lightbox.tsx` | `LightboxProvider`, `useLightbox` | modal portal + context |

## Private subcomponents (colocated)

- In `App.tsx`: `PanelWithSubagents`, `MiniPanel`, `Toggle`
- In `PanelCard.tsx`: `PanelHeader`, `HeaderActions`, `ChecklistPin`, `ThinkingIndicator`, `TurnLightbox`, `PanelLightboxContent`
- In `EventList.tsx`: `Item` (dispatcher), `Bubble`, `BubblePartView`, `ThinkingEvent`, `SystemEvent`, `MetaEvent`
- In `ToolCapsule.tsx`: `ToolLightboxContent`

## Hierarchy

```
App  ── LightboxProvider wraps
├── .topbar
│   ├── Toggle × 4 + theme toggle + debug buttons (inline)
│   └── .conn status badge (inline)
├── .grid
│   └── PanelWithSubagents
│       └── PanelCard
│           ├── PanelHeader
│           │   ├── .panel-title / .panel-idle / .panel-status (inline)
│           │   └── HeaderActions  (popout, fullscreen, +sub, ×, 🗑)
│           ├── ChecklistPin?
│           ├── .panel-body
│           │   ├── EventList
│           │   │   └── Item ─ dispatches to:
│           │   │       ├── Bubble → BubblePartView → Markdown
│           │   │       ├── ToolCapsule  (own file)
│           │   │       └── ThinkingEvent / SystemEvent / MetaEvent
│           │   └── ThinkingIndicator?
│           └── (TurnLightbox + PanelLightboxContent are rendered into the lightbox portal)
├── .mini-tray
│   └── MiniPanel → PanelCard (status=mini)
└── <dialog> (LightboxProvider portal)
```

## Shape & extraction candidates

The taxonomy is healthy: one component per *concept*, dispatch through `Item`, and `PanelCard` is the only "fat" file (~290 LOC). Things currently inline that look like extraction candidates if we scale:

- **Status pill** — used in `PanelHeader`, `ToolCapsule`, and (subtly) topbar `.conn`. Three call sites with diverging classes.
- **`HeaderActions` icon buttons** — inline JSX with hardcoded glyphs/titles; a `<PanelButton icon title onClick />` would clean it up.
- **`Toggle`** (in `App.tsx`) — already a component but lives in App; if more controls land, move to `components/`.
- **`EventTime`** — already extracted, good.
- **Topbar** itself — currently ~80 lines inside `App.tsx`. Becomes a candidate as more controls land.
- **`ChecklistPin`** is small but self-contained; promote to its own file if checklists grow features.

Nothing here is wrong today. The natural "next file" if/when `PanelCard` gets busier is `components/PanelHeader.tsx` (PanelHeader + HeaderActions + status pill).
