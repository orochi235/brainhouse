# Mini Hover Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hover-revealed three-button toolbar (restore / pin-to-minibar / trash) sliding up from the bottom edge of every mini-mode panel in the sidebar tray.

**Architecture:** A new `<MiniHoverToolbar>` component is rendered inside `PanelCard` when `renderMini` is true. It is absolutely positioned along the bottom edge of the `.panel` article, hidden via `transform: translateY(100%)`, revealed on hover of the panel. The component contains three inline-SVG buttons whose handlers (`onRestore`, `onPinToMinibar`, `onHide`) come in as props. The existing inline trash button in `PanelHeader`'s subtitle aside is removed (replaced by the toolbar's trash). A new `restore.svg` asset is added; the pin glyph reuses the existing `StatusLight` rendering used elsewhere. The `onPinToMinibar` prop wires through `MiniPanel` in `App.tsx` to a stub `console.info` — semantics deferred per spec.

**Tech Stack:** React 18 + TypeScript, plain CSS in `client/src/app.css`, Vitest + jsdom for unit tests, existing `?raw` SVG imports via Vite.

**Spec:** `docs/superpowers/specs/2026-06-09-mini-hover-toolbar-design.md`

---

## File map

- **Create:** `client/src/components/MiniHoverToolbar.tsx` — the new toolbar component.
- **Create:** `client/src/assets/icons/restore-arc.svg` — custom restore glyph (U with arrowhead).
- **Create:** `client/src/assets/icons/pin.svg` — pin glyph for the toolbar.
- **Create:** `client/src/components/MiniHoverToolbar.test.tsx` — unit tests.
- **Modify:** `client/src/components/PanelCard.tsx` — accept `onPinToMinibar` prop, render toolbar in mini mode, remove the duplicated inline trash button at lines 655–672.
- **Modify:** `client/src/App.tsx` — pass `onPinToMinibar` through `MiniPanel` to `PanelCard`.
- **Modify:** `client/src/app.css` — toolbar styles + slide transition + per-button colors.

---

## Task 1: Add restore-arc SVG asset

**Files:**
- Create: `client/src/assets/icons/restore-arc.svg`

- [ ] **Step 1: Create the SVG file**

Write the file with this exact content:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <!-- U-shaped arc, opening at 9:00 (left). Drawn from the top end down,
       around the right side, and back up to the bottom-left end. -->
  <path d="M5 3 A 5 5 0 1 1 5 13" />
  <!-- Arrowhead at the top end (5,3), pointing leftward along the arc's
       tangent (which at the top of a left-opening U is horizontal-left). -->
  <polyline points="8 1.5 5 3 6.5 6" />
</svg>
```

- [ ] **Step 2: Visually verify**

Run: `open client/src/assets/icons/restore-arc.svg` — eyeball the glyph: U opens left, arrowhead at top pointing left/up.

- [ ] **Step 3: Commit**

```bash
git add client/src/assets/icons/restore-arc.svg
git commit -m "feat(icons): add restore-arc glyph for mini hover toolbar"
```

---

## Task 2: Add pin SVG asset

**Files:**
- Create: `client/src/assets/icons/pin.svg`

- [ ] **Step 1: Create the SVG file**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M9.5 1.5 L14.5 6.5 L12 7 L11.5 11 L8.5 8 L4 12.5 V11 L7.5 7 L5 6.5 Z" />
</svg>
```

- [ ] **Step 2: Commit**

```bash
git add client/src/assets/icons/pin.svg
git commit -m "feat(icons): add pin glyph for mini hover toolbar"
```

---

## Task 3: Write failing tests for MiniHoverToolbar

**Files:**
- Create: `client/src/components/MiniHoverToolbar.test.tsx`

- [ ] **Step 1: Write the test file**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MiniHoverToolbar } from './MiniHoverToolbar.tsx';

describe('MiniHoverToolbar', () => {
  it('renders three buttons with accessible labels', () => {
    render(
      <MiniHoverToolbar
        onRestore={() => {}}
        onPinToMinibar={() => {}}
        onTrash={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pin/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /trash|remove/i })).toBeInTheDocument();
  });

  it('invokes the matching handler on click', async () => {
    const onRestore = vi.fn();
    const onPinToMinibar = vi.fn();
    const onTrash = vi.fn();
    render(
      <MiniHoverToolbar
        onRestore={onRestore}
        onPinToMinibar={onPinToMinibar}
        onTrash={onTrash}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /restore/i }));
    await user.click(screen.getByRole('button', { name: /pin/i }));
    await user.click(screen.getByRole('button', { name: /trash|remove/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onPinToMinibar).toHaveBeenCalledTimes(1);
    expect(onTrash).toHaveBeenCalledTimes(1);
  });

  it('stops click propagation so the parent row click handler does not fire', async () => {
    const onRowClick = vi.fn();
    const onRestore = vi.fn();
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: test fixture.
      <div onClick={onRowClick}>
        <MiniHoverToolbar
          onRestore={onRestore}
          onPinToMinibar={() => {}}
          onTrash={() => {}}
        />
      </div>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd client && npx vitest run src/components/MiniHoverToolbar.test.tsx`
Expected: FAIL — module not found.

---

## Task 4: Implement MiniHoverToolbar component

**Files:**
- Create: `client/src/components/MiniHoverToolbar.tsx`

- [ ] **Step 1: Implement the component**

```tsx
import restoreIcon from '../assets/icons/restore-arc.svg?raw';
import pinIcon from '../assets/icons/pin.svg?raw';
import trashIcon from '../assets/icons/trash.svg?raw';

interface Props {
  onRestore: () => void;
  onPinToMinibar: () => void;
  onTrash: () => void;
}

export function MiniHoverToolbar({ onRestore, onPinToMinibar, onTrash }: Props) {
  return (
    <div className="mini-hover-toolbar" aria-hidden={false}>
      <ToolbarButton
        kind="restore"
        title="Restore to grid"
        svg={restoreIcon}
        onClick={onRestore}
      />
      <ToolbarButton
        kind="pin"
        title="Pin to minibar"
        svg={pinIcon}
        onClick={onPinToMinibar}
      />
      <ToolbarButton
        kind="trash"
        title="Remove"
        svg={trashIcon}
        onClick={onTrash}
      />
    </div>
  );
}

function ToolbarButton({
  kind,
  title,
  svg,
  onClick,
}: {
  kind: 'restore' | 'pin' | 'trash';
  title: string;
  svg: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`mini-hover-toolbar__btn mini-hover-toolbar__btn--${kind}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span
        className="svg-glyph"
        aria-hidden="true"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time bundled SVG markup.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </button>
  );
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd client && npx vitest run src/components/MiniHoverToolbar.test.tsx`
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/MiniHoverToolbar.tsx client/src/components/MiniHoverToolbar.test.tsx
git commit -m "feat(panel): MiniHoverToolbar component with restore/pin/trash buttons"
```

---

## Task 5: Add toolbar CSS (slide-up + per-button colors)

**Files:**
- Modify: `client/src/app.css` — append to end of the `.panel.status-mini` rule section (search for `.panel.status-mini .panel-trash` around line 1747 and add the new rules immediately after that block).

- [ ] **Step 1: Add the styles**

Append after the existing `.panel.status-mini .panel-trash` rules (around line 1755):

```css
/* Hover-revealed action toolbar for mini panels. Sits along the bottom
 * edge of the mini row; the panel's overflow:hidden clips it when
 * translated below. */
.panel.status-mini .mini-hover-toolbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  height: 24px;
  transform: translateY(100%);
  opacity: 0;
  transition:
    transform 150ms ease-out,
    opacity 150ms ease-out;
  pointer-events: none;
  z-index: 2;
}

.panel.status-mini:hover .mini-hover-toolbar,
.panel.status-mini:focus-within .mini-hover-toolbar {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}

.mini-hover-toolbar__btn {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  cursor: pointer;
}

.mini-hover-toolbar__btn .svg-glyph {
  display: inline-flex;
  width: 14px;
  height: 14px;
}

.mini-hover-toolbar__btn .svg-glyph svg {
  width: 100%;
  height: 100%;
}

.mini-hover-toolbar__btn--restore {
  background: #2e8b57; /* green */
}

.mini-hover-toolbar__btn--pin {
  background: #dc143c; /* crimson */
}

.mini-hover-toolbar__btn--trash {
  background: #6b7280; /* gray */
}

.mini-hover-toolbar__btn:hover {
  filter: brightness(1.15);
}

.mini-hover-toolbar__btn:active {
  filter: brightness(0.9);
}
```

- [ ] **Step 2: Verify the .panel article is a positioning context**

Run: `grep -n "^\.panel \{\|^\.panel$" client/src/app.css | head -5`

Then inspect the `.panel` rule with: `grep -n -A 8 "^\.panel {" client/src/app.css | head -20`.

If `position: relative` is not already on `.panel`, add it. Mini panels currently use `overflow: hidden` and need to clip the absolutely-positioned toolbar.

Expected (if missing): add `position: relative;` to the `.panel` rule. If present, no change needed.

- [ ] **Step 3: Commit**

```bash
git add client/src/app.css
git commit -m "style(panel): slide-up hover toolbar for mini panels"
```

---

## Task 6: Wire toolbar into PanelCard

**Files:**
- Modify: `client/src/components/PanelCard.tsx`

- [ ] **Step 1: Add the import**

Add this import alongside the existing component imports (near line 27 with the other `./` imports):

```ts
import { MiniHoverToolbar } from './MiniHoverToolbar.tsx';
```

- [ ] **Step 2: Add `onPinToMinibar` to the Props interface**

In the `Props` interface (around lines 38–77), add:

```ts
  /** Pin this mini panel to the minibar permanently. Semantics deferred
   * — the handler is a stub for now. Only meaningful in mini-tray mode. */
  onPinToMinibar?: () => void;
```

- [ ] **Step 3: Destructure the new prop in `PanelCard`**

In the `PanelCard` function signature (around lines 85–99), add `onPinToMinibar` to the destructured props list, immediately after `onTogglePin`.

- [ ] **Step 4: Render the toolbar**

In the JSX returned by `PanelCard` (around line 354, right after the `{checklist && <ChecklistPin … />}` line), add:

```tsx
        {renderMini && onRestore && (
          <MiniHoverToolbar
            onRestore={onRestore}
            onPinToMinibar={() => onPinToMinibar?.()}
            onTrash={() => {
              trpc.remove.mutate({ panelId: panel.id });
            }}
          />
        )}
```

- [ ] **Step 5: Remove the duplicated inline trash button**

Delete lines 655–672 of `PanelCard.tsx` — the entire `{renderMini && !readOnly && ( <button … panel-trash … /> )}` block in `PanelHeader`'s `subtitleAside`. The toolbar replaces it.

- [ ] **Step 6: Run typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: PASS, no new errors.

- [ ] **Step 7: Run the full client test suite**

Run: `cd client && npx vitest run`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/PanelCard.tsx
git commit -m "feat(panel): render MiniHoverToolbar on mini panels, drop inline trash"
```

---

## Task 7: Plumb `onPinToMinibar` through App.tsx

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Pass the stub prop into MiniPanel**

At the `<MiniPanel … />` call site (around line 922), add a new prop on the JSX:

```tsx
                  onPinToMinibar={() => {
                    // TODO: real minibar pin semantics — see
                    // docs/superpowers/specs/2026-06-09-mini-hover-toolbar-design.md
                    console.info('[minibar pin] requested for', p.id);
                  }}
```

- [ ] **Step 2: Add the prop to MiniPanel**

In the `MiniPanel` function (around lines 1322–1374):

a) Add to the destructured params list (after `onTogglePin: _onTogglePin,`):

```ts
  onPinToMinibar,
```

b) Add to the inline type:

```ts
  onPinToMinibar: () => void;
```

c) Forward it to `<PanelCard>` (around line 1366):

```tsx
      <PanelCard
        panel={panel}
        onHide={onHide}
        onRestore={onRestore}
        onPinToMinibar={onPinToMinibar}
        account={account}
        accountColor={accountColor}
      />
```

- [ ] **Step 3: Typecheck + tests**

Run in parallel: `cd client && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(app): wire onPinToMinibar stub through MiniPanel"
```

---

## Task 8: Manual verification in the running app

- [ ] **Step 1: Confirm dev server is running**

The session reminder lists running processes. If `vite` / `npm run dev` is not present, start it:

Run (background): `cd /Users/mike/src/brainhouse && npm run dev`

- [ ] **Step 2: Open the app and find a mini panel**

Open the app in a browser (or use the existing Playwright MCP session at pid 46913). Find or wait for a panel in the right-side tray (mini mode).

- [ ] **Step 3: Hover-test the toolbar**

Hover the mini row. Expected:
- Three-segment toolbar slides up from the bottom edge in ~150ms.
- Left segment is green with the U-arc + arrowhead glyph.
- Middle segment is crimson with a pin glyph.
- Right segment is gray with a trash glyph.
- Moving the cursor off the row slides the toolbar back down.

- [ ] **Step 4: Click-test each button**

- Click restore → the panel returns to the grid (full-size).
- Find another mini panel. Click pin → check devtools console for `[minibar pin] requested for <panelId>`.
- Find another mini panel. Click trash → panel disappears from the tray (existing remove flow).

In all three cases, confirm the row's existing "click-to-restore" handler did NOT fire alongside the button click (i.e. no double action).

- [ ] **Step 5: Take a screenshot for the PR**

If using Playwright MCP, capture the toolbar in its hovered state and save it for the eventual PR description.

---

## Out of scope (do NOT implement)

- Minibar pin semantics (eviction, sort, persistence). The pin button is a stub.
- Restyling other affordances on the mini row (status light, leading close).
- Animation polish beyond the ~150ms slide.
- Keyboard navigation for the toolbar (focus-within reveals it; full keyboard story is a follow-up).
