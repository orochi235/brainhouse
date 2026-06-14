import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampStripHeight,
  DebugDock,
  DEBUG_STRIP_MIN_PX,
  loadPanelOpen,
  loadStripHeight,
  savePanelOpen,
  saveStripHeight,
  STRIP_MAX_FRACTION,
} from './DebugDock.tsx';

describe('clampStripHeight', () => {
  it('leaves a height within bounds untouched', () => {
    expect(clampStripHeight(300, 1000)).toBe(300);
  });

  it('floors a too-small height at the minimum', () => {
    expect(clampStripHeight(10, 1000)).toBe(DEBUG_STRIP_MIN_PX);
  });

  it('caps a too-large height at the container fraction', () => {
    expect(clampStripHeight(950, 1000)).toBe(1000 * STRIP_MAX_FRACTION);
  });

  it('never returns below the minimum even in a tiny container', () => {
    // 70% of 100 = 70, which is below the 120 floor — the floor wins.
    expect(clampStripHeight(80, 100)).toBe(DEBUG_STRIP_MIN_PX);
  });
});

describe('strip height persistence', () => {
  afterEach(() => localStorage.clear());

  it('round-trips a saved height (re-clamped on load)', () => {
    saveStripHeight(320);
    expect(loadStripHeight(1000)).toBe(320);
  });

  it('falls back to a clamped default when nothing is stored', () => {
    const h = loadStripHeight(1000);
    expect(h).toBeGreaterThanOrEqual(DEBUG_STRIP_MIN_PX);
    expect(h).toBeLessThanOrEqual(1000 * STRIP_MAX_FRACTION);
  });

  it('re-clamps a stored height that no longer fits the container', () => {
    saveStripHeight(900);
    expect(loadStripHeight(400)).toBe(400 * STRIP_MAX_FRACTION);
  });
});

describe('debug panel open state', () => {
  afterEach(() => localStorage.clear());

  it('defaults to open when nothing is stored', () => {
    expect(loadPanelOpen()).toBe(true);
  });

  it('round-trips the open flag', () => {
    savePanelOpen(false);
    expect(loadPanelOpen()).toBe(false);
    savePanelOpen(true);
    expect(loadPanelOpen()).toBe(true);
  });
});

describe('DebugDock drag', () => {
  afterEach(() => localStorage.clear());

  function strip(c: HTMLElement) {
    return c.querySelector<HTMLElement>('.debug-strip')!;
  }


  it('renders a handle and a strip holding its children', () => {
    const { container } = render(<DebugDock><span>child</span></DebugDock>);
    expect(container.querySelector('.debug-strip-handle')).not.toBeNull();
    expect(strip(container).textContent).toBe('child');
  });

  it('grows the strip when the handle is dragged upward and persists on release', () => {
    saveStripHeight(200);
    const { container } = render(<DebugDock><span>child</span></DebugDock>);
    // happy-dom reports 0 for clientHeight, so the container budget falls
    // back to window.innerHeight (well above the floor); the drag math is
    // what's under test here.
    const handle = container.querySelector<HTMLElement>('.debug-strip-handle')!;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    const before = parseInt(strip(container).style.height, 10);

    fireEvent.pointerDown(handle, { clientY: 500 });
    fireEvent.pointerMove(handle, { clientY: 440 }); // up 60px
    fireEvent.pointerUp(handle, { clientY: 440 });

    expect(parseInt(strip(container).style.height, 10)).toBe(before + 60);
    expect(loadStripHeight(2000)).toBe(before + 60); // persisted
  });
});
