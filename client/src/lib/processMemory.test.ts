import { describe, expect, it } from 'vitest';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow } from '../useProcesses.ts';
import { IDLE_THRESHOLDS, reclaimable, subtreeRss } from './processMemory.ts';

function row(over: Partial<ProcessRow> & { pid: number }): ProcessRow {
  return {
    process_id: `p${over.pid}`,
    host: 'local',
    pid: over.pid,
    ppid: 0,
    start_ts: 0,
    command: 'x',
    cwd: null,
    session_id: null,
    hook_command: null,
    run_in_background: false,
    provenance: 'observed',
    runtime: null,
    runtime_version: null,
    runtime_source: null,
    framework: null,
    framework_version: null,
    ports: [],
    ended_ts: null,
    ended_reason: null,
    uptime_s: 0,
    rss_kb: 0,
    bash_id: null,
    project: null,
    account_label: null,
    iterm_session_id: null,
    original_ancestors: [],
    ...over,
  } as ProcessRow;
}

function panel(id: string, lastEventAt: number): PanelState {
  return { id, last_event_at: lastEventAt } as unknown as PanelState;
}

/** claude(1) → mcp(2) → helper(3), plus a sibling leaf(4). */
function tree() {
  const rows = {
    root: row({ pid: 1, rss_kb: 100, session_id: 's1', runtime: 'claude' }),
    mcp: row({ pid: 2, ppid: 1, rss_kb: 800 }),
    helper: row({ pid: 3, ppid: 2, rss_kb: 200 }),
    leaf: row({ pid: 4, ppid: 1, rss_kb: 50 }),
  };
  const childrenByPid = new Map<number, ProcessRow[]>([
    [1, [rows.mcp, rows.leaf]],
    [2, [rows.helper]],
  ]);
  return { rows, childrenByPid };
}

describe('subtreeRss', () => {
  it('sums a row and every descendant', () => {
    const { rows, childrenByPid } = tree();
    expect(subtreeRss(rows.root, childrenByPid)).toBe(1150);
    expect(subtreeRss(rows.mcp, childrenByPid)).toBe(1000);
    expect(subtreeRss(rows.leaf, childrenByPid)).toBe(50);
  });

  it('terminates on a cycle instead of recursing forever', () => {
    const a = row({ pid: 1, rss_kb: 10 });
    const b = row({ pid: 2, ppid: 1, rss_kb: 20 });
    const childrenByPid = new Map<number, ProcessRow[]>([
      [1, [b]],
      [2, [a]],
    ]);
    expect(subtreeRss(a, childrenByPid)).toBe(30);
  });
});

describe('reclaimable', () => {
  const NOW = 1_000_000;

  it('totals subtree RSS for roots idle past the threshold', () => {
    const { rows, childrenByPid } = tree();
    const panels = new Map([['s1', panel('s1', NOW - 7200)]]);
    const r = reclaimable([rows.root], childrenByPid, panels, 3600, NOW);
    expect(r.treeCount).toBe(1);
    expect(r.totalKb).toBe(1150);
    expect([...r.sessionIds]).toEqual(['s1']);
  });

  it('excludes a root idle for less than the threshold', () => {
    const { rows, childrenByPid } = tree();
    const panels = new Map([['s1', panel('s1', NOW - 60)]]);
    const r = reclaimable([rows.root], childrenByPid, panels, 3600, NOW);
    expect(r).toMatchObject({ treeCount: 0, totalKb: 0 });
    expect(r.sessionIds.size).toBe(0);
  });

  it('excludes a root with no panel rather than assuming it is idle', () => {
    const { rows, childrenByPid } = tree();
    const r = reclaimable([rows.root], childrenByPid, new Map(), 3600, NOW);
    expect(r).toMatchObject({ treeCount: 0, totalKb: 0 });
  });

  it('excludes a root with no session_id', () => {
    const { childrenByPid } = tree();
    const orphan = row({ pid: 1, rss_kb: 100, runtime: 'claude' });
    const panels = new Map([['s1', panel('s1', NOW - 7200)]]);
    const r = reclaimable([orphan], childrenByPid, panels, 3600, NOW);
    expect(r).toMatchObject({ treeCount: 0, totalKb: 0 });
  });

  it('totals across several idle trees', () => {
    const { rows, childrenByPid } = tree();
    const second = row({ pid: 10, rss_kb: 400, session_id: 's2', runtime: 'claude' });
    const panels = new Map([
      ['s1', panel('s1', NOW - 7200)],
      ['s2', panel('s2', NOW - 90_000)],
    ]);
    const r = reclaimable([rows.root, second], childrenByPid, panels, 3600, NOW);
    expect(r.treeCount).toBe(2);
    expect(r.totalKb).toBe(1550);
  });
});

describe('IDLE_THRESHOLDS', () => {
  it('matches the buckets IdleCell already colors on', () => {
    expect(IDLE_THRESHOLDS.map((t) => t.seconds)).toEqual([300, 1800, 7200, 21600, 86400, 604800]);
  });
});
