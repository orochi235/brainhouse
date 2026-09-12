import { describe, expect, it } from 'vitest';
import {
  itermCommand,
  launchScript,
  type ReportContext,
  renderReport,
  reportFileName,
} from './reportIssue.js';

function ctx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    panelId: 'aac37d1e119bac1ee',
    kind: 'subagent',
    parentPanelId: '59abb1c3-4a6b-457f-92fa-043f589d67e9',
    title: 'Lab: yaw, depth shading',
    agentType: 'general-purpose',
    accountLabel: 'MSB',
    status: 'mini',
    cwd: '/Users/mike/src/blitsklieg',
    repoRoot: '/Users/mike/src/blitsklieg',
    startedAt: 1_755_000_000,
    lastEventAt: 1_755_001_000,
    transcriptPath: '/Users/mike/.claude-msb/projects/x/subagents/agent-aac37d1e119bac1ee.jsonl',
    brainhouseRevision: '2b1cd60',
    ...overrides,
  };
}

describe('renderReport', () => {
  it('carries the reporter text, the panel id and the transcript path', () => {
    const md = renderReport('  the subagent lost its project label  ', ctx());
    expect(md).toContain('the subagent lost its project label');
    expect(md).toContain('aac37d1e119bac1ee');
    expect(md).toContain('agent-aac37d1e119bac1ee.jsonl');
  });

  it('states that the transcript is missing rather than printing null', () => {
    const md = renderReport('x', ctx({ transcriptPath: null }));
    expect(md).toContain('not found on disk');
    expect(md).not.toContain('null');
  });

  it('renders timestamps as ISO strings, not epoch seconds', () => {
    const md = renderReport('x', ctx({ startedAt: 1_755_000_000 }));
    expect(md).toContain(new Date(1_755_000_000 * 1000).toISOString());
    expect(md).not.toContain('1755000000');
  });
});

describe('launchScript', () => {
  it('quotes a repo path containing spaces', () => {
    expect(launchScript('/Users/mike/my src/brainhouse')).toContain(
      "cd '/Users/mike/my src/brainhouse'",
    );
  });

  it('passes the report path through as $1 rather than baking it in', () => {
    expect(launchScript('/repo')).toContain('claude "$(cat "$1")"');
  });

  // The window's own shell stays alive because the command is typed at its
  // prompt rather than replacing it, so the launcher must not exec a new one.
  it('does not exec a replacement shell', () => {
    expect(launchScript('/repo')).not.toContain('exec');
  });
});

describe('itermCommand', () => {
  it('is a bare quoted invocation — iTerm types it into a login shell already', () => {
    const cmd = itermCommand('/reports/launch.sh', '/reports/r.md');
    expect(cmd).toBe("'/reports/launch.sh' '/reports/r.md'");
  });

  it('escapes a single quote in a path instead of ending the quoted string', () => {
    const cmd = itermCommand('/reports/launch.sh', "/reports/mike's.md");
    expect(cmd).toContain(`'\\''`);
  });
});

describe('reportFileName', () => {
  it('is filesystem-safe and carries the panel id', () => {
    const name = reportFileName('a/b:c', new Date('2026-08-19T00:59:00.000Z'));
    expect(name).toBe('2026-08-19T00-59-00-000Z-a_b_c.md');
  });
});
