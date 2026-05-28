import { describe, expect, it } from 'vitest';
import { buildProjectRollups, deriveProjectWidgets } from './projectWidgets.ts';
import type { PanelState } from '../useDeltaStream.ts';

const p = (
  id: string,
  cwd: string | null,
  last: number,
  repo_root: string | null = null,
): PanelState =>
  ({
    id,
    cwd,
    repo_root,
    last_event_at: last,
    kind: 'parent',
    status: 'live',
    started_at: last - 100,
    awaiting_input: false,
    ended: false,
    title: `title-${id}`,
    account_label: null,
    theme: null,
    events: [],
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
  }) as unknown as PanelState;

const mapOf = (...panels: PanelState[]) => {
  const m = new Map<string, PanelState>();
  for (const x of panels) m.set(x.id, x);
  return m;
};

describe('deriveProjectWidgets', () => {
  it('emits one widget per repo, collapsing worktrees', () => {
    const widgets = deriveProjectWidgets(
      mapOf(
        p('a', '/Users/mike/src/brainhouse', 100),
        p('b', '/Users/mike/src/brainhouse/.claude/worktrees/foo', 200),
        p('c', '/Users/mike/src/weasel', 150),
      ),
    );
    expect(widgets.map((w) => w.repo)).toEqual(['brainhouse', 'weasel']);
  });

  it("picks the most-recent session's cwd as the project's representative", () => {
    const widgets = deriveProjectWidgets(
      mapOf(
        p('a', '/Users/mike/src/brainhouse', 100),
        p('b', '/Users/mike/src/brainhouse/.claude/worktrees/foo', 200),
      ),
    );
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.cwd).toBe('/Users/mike/src/brainhouse/.claude/worktrees/foo');
    expect(widgets[0]?.last_event_at).toBe(200);
  });

  it('orders widgets most-recently-active first', () => {
    const widgets = deriveProjectWidgets(
      mapOf(
        p('a', '/Users/mike/src/brainhouse', 100),
        p('b', '/Users/mike/src/weasel', 200),
        p('c', '/Users/mike/src/lightbird/foo', 150),
      ),
    );
    expect(widgets.map((w) => w.repo)).toEqual(['weasel', 'foo', 'brainhouse']);
  });

  it('ignores panels with no cwd', () => {
    const widgets = deriveProjectWidgets(mapOf(p('a', null, 100)));
    expect(widgets).toEqual([]);
  });

  it('widget id namespaces under project: to avoid uuid collisions', () => {
    const widgets = deriveProjectWidgets(mapOf(p('a', '/Users/mike/src/brainhouse', 100)));
    expect(widgets[0]?.id).toBe('project:brainhouse');
  });
});

describe('buildProjectRollups', () => {
  it('counts parent sessions and excludes subagents from the session list', () => {
    const parent = p('a', '/Users/mike/src/brainhouse', 100);
    const sub = {
      ...p('b', '/Users/mike/src/brainhouse', 90),
      kind: 'subagent',
      parent_panel_id: 'a',
    } as unknown as PanelState;
    const rollups = buildProjectRollups(mapOf(parent, sub));
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.sessionCount).toBe(1);
    expect(rollups[0]?.recentSessions.map((s) => s.id)).toEqual(['a']);
  });

  it('aggregates input-equivalent tokens across panels in a project', () => {
    const a = {
      ...p('a', '/Users/mike/src/brainhouse', 100),
      tokens: { input: 100, output: 10, cache_create: 0, cache_read: 0, model: null },
    } as unknown as PanelState;
    const b = {
      ...p('b', '/Users/mike/src/brainhouse', 200),
      tokens: { input: 50, output: 4, cache_create: 0, cache_read: 0, model: null },
    } as unknown as PanelState;
    const rollups = buildProjectRollups(mapOf(a, b));
    // (100 + 10*5) + (50 + 4*5) = 150 + 70 = 220
    expect(rollups[0]?.totalTokens).toBe(220);
  });

  it('counts unique file paths from Read/Edit/Write/MultiEdit tool_use events', () => {
    const evts = [
      {
        kind: 'tool_use',
        payload: { name: 'Read', input: { file_path: '/a.ts' } },
      },
      {
        kind: 'tool_use',
        payload: { name: 'Edit', input: { file_path: '/a.ts' } },
      },
      {
        kind: 'tool_use',
        payload: { name: 'Write', input: { file_path: '/b.ts' } },
      },
      {
        kind: 'tool_use',
        payload: { name: 'Bash', input: { command: 'ls' } },
      },
    ];
    const panel = {
      ...p('a', '/Users/mike/src/brainhouse', 100),
      events: evts,
    } as unknown as PanelState;
    const rollups = buildProjectRollups(mapOf(panel));
    expect(rollups[0]?.fileCount).toBe(2);
  });

  it('groups sessions from subdirectories of the same repo via repo_root', () => {
    // Three sessions in the same checkout but `cd`d to different subdirs.
    // Without `repo_root`, each would fragment to its own widget keyed
    // by the leaf segment ('brainhouse', 'client', 'server').
    const a = p('a', '/Users/mike/src/brainhouse', 100, '/Users/mike/src/brainhouse');
    const b = p('b', '/Users/mike/src/brainhouse/client', 200, '/Users/mike/src/brainhouse');
    const c = p('c', '/Users/mike/src/brainhouse/server', 300, '/Users/mike/src/brainhouse');
    const rollups = buildProjectRollups(mapOf(a, b, c));
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.widget.repo).toBe('brainhouse');
    expect(rollups[0]?.sessionCount).toBe(3);
    expect(rollups[0]?.recentSessions.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('still falls back to cwd leaf when repo_root is null (non-git scratch dirs)', () => {
    const a = p('a', '/tmp/scratch', 100, null);
    const b = p('b', '/tmp/other', 200, null);
    const rollups = buildProjectRollups(mapOf(a, b));
    expect(rollups.map((r) => r.widget.repo).sort()).toEqual(['other', 'scratch']);
  });

  it('carries the most-recent panel theme and account_label into the rollup', () => {
    const older = {
      ...p('a', '/Users/mike/src/brainhouse', 100),
      theme: { background: '#111', foreground: '#fff' },
      account_label: 'personal',
    } as unknown as PanelState;
    const newer = {
      ...p('b', '/Users/mike/src/brainhouse', 200),
      theme: { background: '#222', foreground: '#eee' },
      account_label: 'work',
    } as unknown as PanelState;
    const rollups = buildProjectRollups(mapOf(older, newer));
    expect(rollups[0]?.theme).toEqual({ background: '#222', foreground: '#eee' });
    expect(rollups[0]?.account_label).toBe('work');
  });
});
