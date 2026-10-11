import { describe, expect, it } from 'vitest';
import { ArchiveHealth, type ArchiveVerdict } from './archiveHealth.js';

function setup() {
  const sent: string[] = [];
  const world = { now: 0, verdict: null as ArchiveVerdict | null };
  const health = new ArchiveHealth({
    notify: (title, body) => sent.push(`${title}: ${body}`),
    read: async () => world.verdict,
    now: () => world.now,
  });
  return { sent, world, health };
}

const MIN = 60_000;
const STOPPED = { warn: true, text: 'no run since 2026-10-01' };

describe('ArchiveHealth', () => {
  it('says nothing when icehouse has no record or its runs are fine', async () => {
    const { sent, world, health } = setup();
    await health.check();
    world.verdict = { warn: false, text: 'last good run 2026-10-11' };
    world.now = 60 * MIN;
    await health.check();
    expect(health.warning).toBe('');
    expect(sent).toEqual([]);
  });

  it('shows a warning at once and sends one banner after it has held ten minutes', async () => {
    const { sent, world, health } = setup();
    world.verdict = STOPPED;
    await health.check();
    expect(health.warning).toBe('no run since 2026-10-01');
    expect(sent).toEqual([]);

    world.now = 10 * MIN;
    await health.check();
    world.now = 60 * MIN;
    await health.check();
    expect(sent).toEqual(['icehouse needs attention: no run since 2026-10-01']);
  });

  it('sends nothing for a warning that clears inside ten minutes, and again for a new episode', async () => {
    const { sent, world, health } = setup();
    world.verdict = STOPPED;
    await health.check();
    world.now = 5 * MIN;
    world.verdict = { warn: false, text: '' };
    await health.check();
    world.now = 20 * MIN;
    world.verdict = STOPPED;
    await health.check();
    expect(sent).toEqual([]);

    world.now = 30 * MIN;
    await health.check();
    expect(sent).toHaveLength(1);
  });
});
