import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptMonitor } from './monitor.js';
import { getScenario, listScenarios, SCENARIOS } from './scenarios.js';

let monitor: TranscriptMonitor;

beforeEach(() => {
  monitor = new TranscriptMonitor({ roots: [], hookEventsDir: null });
});

afterEach(async () => {
  await monitor.stop().catch(() => {});
});

describe('scenarios', () => {
  it('listScenarios returns metadata for every registered scenario', () => {
    expect(listScenarios()).toHaveLength(SCENARIOS.length);
    for (const meta of listScenarios()) {
      expect(meta.key).toBeTruthy();
      expect(meta.name).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.expect).toBeTruthy();
    }
  });

  it('getScenario returns the scenario by key', () => {
    expect(getScenario('interrupt')?.key).toBe('interrupt');
    expect(getScenario('not-a-real-key')).toBeUndefined();
  });

  it('every scenario key is unique', () => {
    const keys = SCENARIOS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Run every scenario end-to-end. We don't assert on exact event counts —
  // that ties tests to implementation details — but we DO assert each one
  // creates at least one panel without throwing.
  for (const s of SCENARIOS) {
    it(`scenario "${s.key}" runs without error and produces a panel`, async () => {
      const { sessionId } = await s.run(monitor, {});
      // Each scenario creates at least the parent panel under sessionId; some
      // also create subagent panels.
      const panel = monitor.store.panel(sessionId);
      expect(panel).toBeDefined();
    });
  }
});

describe('scenarios — feature exercises', () => {
  it('interrupt: pipeline-side rendering of the cancellation', async () => {
    const { sessionId } = await getScenario('interrupt')!.run(monitor, {});
    const panel = monitor.store.panel(sessionId);
    if (!panel) throw new Error('no panel');
    // 4 raw events emitted: u1, a1, interrupt-user, u2 (interrupt is filtered
    // at pipeline time, not session time, so store keeps it).
    expect(panel.events.length).toBe(4);
  });

  it('awaiting-input: notification hook flips awaiting_input', async () => {
    const { sessionId } = await getScenario('awaiting-input')!.run(monitor, {});
    expect(monitor.store.panel(sessionId)?.awaiting_input).toBe(true);
  });

  it('ended-subagent: SubagentStop flips ended on the sub but not the parent', async () => {
    const { sessionId } = await getScenario('ended-subagent')!.run(monitor, {});
    const parent = monitor.store.panel(sessionId);
    expect(parent?.ended).toBe(false);
    // Find the subagent — its id starts with `agent-`.
    const subs = Array.from(monitor.store.snapshot()).filter(
      (p) => p.parent_panel_id === sessionId,
    );
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.ended === true)).toBe(true);
  });

  it('parent-stop-no-dim: ended stays false even after Stop hook', async () => {
    const { sessionId } = await getScenario('parent-stop-no-dim')!.run(monitor, {});
    const panel = monitor.store.panel(sessionId);
    expect(panel?.ended).toBe(false);
    expect(panel?.status).toBe('done');
  });

  it('fan-out: produces a parent + 3 subagents, 2 ended', async () => {
    const { sessionId } = await getScenario('fan-out')!.run(monitor, {});
    const subs = Array.from(monitor.store.snapshot()).filter(
      (p) => p.parent_panel_id === sessionId,
    );
    expect(subs.length).toBe(3);
    expect(subs.filter((s) => s.ended).length).toBe(2);
  });

  it('themed-panel: stamps theme on the panel', async () => {
    const { sessionId } = await getScenario('themed-panel')!.run(monitor, {});
    expect(monitor.store.panel(sessionId)?.theme?.background).toBe('#0e7c66');
  });
});
