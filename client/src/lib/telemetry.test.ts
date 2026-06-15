import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMeasureReaper, stopMeasureReaper } from './telemetry.ts';

describe('startMeasureReaper', () => {
  afterEach(() => {
    stopMeasureReaper();
    vi.useRealTimers();
    (globalThis as { __keepReactMeasures?: boolean }).__keepReactMeasures = undefined;
  });

  it('clears the user-timing buffer on each interval tick (not on start)', () => {
    vi.useFakeTimers();
    const clearMeasures = vi.fn();
    const clearMarks = vi.fn();
    performance.clearMeasures = clearMeasures;
    performance.clearMarks = clearMarks;

    startMeasureReaper(1000);
    expect(clearMeasures).not.toHaveBeenCalled(); // start is lazy

    vi.advanceTimersByTime(1000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    expect(clearMarks).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(clearMeasures).toHaveBeenCalledTimes(3);
  });

  it('pauses reaping while window.__keepReactMeasures is set', () => {
    vi.useFakeTimers();
    const clearMeasures = vi.fn();
    performance.clearMeasures = clearMeasures;
    (globalThis as { __keepReactMeasures?: boolean }).__keepReactMeasures = true;

    startMeasureReaper(1000);
    vi.advanceTimersByTime(3000);
    expect(clearMeasures).not.toHaveBeenCalled();
  });

  it('is idempotent — a second start returns the same stop handle and one timer', () => {
    vi.useFakeTimers();
    const clearMeasures = vi.fn();
    performance.clearMeasures = clearMeasures;

    const stop1 = startMeasureReaper(1000);
    const stop2 = startMeasureReaper(1000);
    expect(stop1).toBe(stop2);

    vi.advanceTimersByTime(1000);
    expect(clearMeasures).toHaveBeenCalledTimes(1); // not 2 — single timer
  });

  it('stop halts further reaping', () => {
    vi.useFakeTimers();
    const clearMeasures = vi.fn();
    performance.clearMeasures = clearMeasures;

    startMeasureReaper(1000);
    vi.advanceTimersByTime(1000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    stopMeasureReaper();
    vi.advanceTimersByTime(3000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
  });
});
