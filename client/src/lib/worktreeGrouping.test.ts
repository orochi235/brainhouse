import { describe, expect, it } from 'vitest';
import type { PanelState } from '../useDeltaStream.ts';
import { groupByWorktreeKey, interleaveWorktreeSeparators } from './worktreeGrouping.ts';

function panel(id: string, cwd: string | null): PanelState {
  return { id, cwd, events: [] } as unknown as PanelState;
}

describe('groupByWorktreeKey', () => {
  it('clusters panels by worktree key, preserving original order within each group', () => {
    const A1 = panel('a1', '/Users/x/weasel/.claude/worktrees/feat-a');
    const B1 = panel('b1', '/Users/x/weasel/.claude/worktrees/feat-b');
    const A2 = panel('a2', '/Users/x/weasel/.claude/worktrees/feat-a');
    const trunk = panel('m', '/Users/x/weasel');
    const result = groupByWorktreeKey([A1, B1, A2, trunk]);
    expect(result.map((p) => p.id)).toEqual(['a1', 'a2', 'b1', 'm']);
  });

  it('sinks panels with no worktree to the end', () => {
    const T1 = panel('t1', '/Users/x/weasel');
    const A1 = panel('a1', '/Users/x/weasel/.claude/worktrees/feat-a');
    const T2 = panel('t2', '/Users/x/weasel');
    const result = groupByWorktreeKey([T1, A1, T2]);
    expect(result.map((p) => p.id)).toEqual(['a1', 't1', 't2']);
  });

  it('no-op when all panels share the same worktree', () => {
    const A1 = panel('a1', '/Users/x/weasel/.claude/worktrees/feat-a');
    const A2 = panel('a2', '/Users/x/weasel/.claude/worktrees/feat-a');
    const result = groupByWorktreeKey([A1, A2]);
    expect(result.map((p) => p.id)).toEqual(['a1', 'a2']);
  });
});

describe('interleaveWorktreeSeparators', () => {
  it('returns panels untouched when disabled', () => {
    const A1 = panel('a1', '/Users/x/weasel/.claude/worktrees/feat-a');
    const B1 = panel('b1', '/Users/x/weasel/.claude/worktrees/feat-b');
    const result = interleaveWorktreeSeparators([A1, B1], false);
    expect(result.map((i) => (i.kind === 'panel' ? i.panel.id : 'sep'))).toEqual(['a1', 'b1']);
  });

  it('emits one separator above each worktree group', () => {
    const A1 = panel('a1', '/Users/x/weasel/.claude/worktrees/feat-a');
    const A2 = panel('a2', '/Users/x/weasel/.claude/worktrees/feat-a');
    const B1 = panel('b1', '/Users/x/weasel/.claude/worktrees/feat-b');
    const result = interleaveWorktreeSeparators([A1, A2, B1], true);
    expect(result.map((i) => (i.kind === 'panel' ? i.panel.id : `sep:${i.label}`))).toEqual([
      'sep:feat-a',
      'a1',
      'a2',
      'sep:feat-b',
      'b1',
    ]);
  });

  it('does not emit a separator above the trunk group', () => {
    const A1 = panel('a1', '/Users/x/weasel/.claude/worktrees/feat-a');
    const T1 = panel('t1', '/Users/x/weasel');
    const result = interleaveWorktreeSeparators([A1, T1], true);
    expect(result.map((i) => (i.kind === 'panel' ? i.panel.id : `sep:${i.label}`))).toEqual([
      'sep:feat-a',
      'a1',
      't1',
    ]);
  });
});
