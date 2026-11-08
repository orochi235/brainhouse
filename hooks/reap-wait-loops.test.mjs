import { describe, expect, it } from 'vitest';
import { classify, parseEtime, parsePs, watchedPaths } from './lib/wait-loops.mjs';

const CLAUDE = 100;
const NOW = Date.parse('2026-11-07T20:00:00Z');
const OLD = 'aaaaaaaa-1111-2222-3333-444444444444';
const CUR = 'bbbbbbbb-1111-2222-3333-444444444444';
const TMP = '/private/tmp/claude-501/-Users-mike-src-weasel';
const SHELL =
  "/bin/zsh -c source /Users/mike/.claude-msb/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '";
const TAIL = "' < /dev/null && pwd -P >| /tmp/claude-16b0-cwd";

const scratchLoop = (sid) =>
  `${SHELL}SP=${TMP}/${sid}/scratchpad; until grep -q "job exited" $SP/run.log; do sleep 10; done; cat $SP/run.log${TAIL}`;
const taskLoop = (sid) =>
  `${SHELL}until [ -s ${TMP}/${sid}/tasks/b1.output ]; do sleep 10; done; cat ${TMP}/${sid}/tasks/b1.output${TAIL}`;

const minutesAgo = (m) => NOW - m * 60_000;
const row = (pid, age, command, ppid = CLAUDE) => ({ pid, ppid, age, command });
const run = (rows, mtimes = {}) =>
  classify(rows, { claudePid: CLAUDE, sessionId: CUR, now: NOW, mtime: (p) => mtimes[p] ?? null });

describe('wait-loop reaper', () => {
  it('parses ps etime', () => {
    expect(parseEtime('00:16')).toBe(16);
    expect(parseEtime('05:06:30')).toBe(5 * 3600 + 6 * 60 + 30);
    expect(parseEtime('01-22:58:51')).toBe(46 * 3600 + 58 * 60 + 51);
  });

  it('parses ps rows', () => {
    expect(parsePs(' 4894 95067 23:54:21 /bin/zsh -c x y\n')).toEqual([
      { pid: 4894, ppid: 95067, age: 23 * 3600 + 54 * 60 + 21, command: '/bin/zsh -c x y' },
    ]);
  });

  it('expands $SP and ignores the shell plumbing paths', () => {
    expect(watchedPaths(scratchLoop(OLD))).toEqual([
      `${TMP}/${OLD}/scratchpad`,
      `${TMP}/${OLD}/scratchpad/run.log`,
    ]);
  });

  it("reaps a cleared session's loop whose log stopped changing", () => {
    const [loop] = run([row(1, 5 * 3600, scratchLoop(OLD))], {
      [`${TMP}/${OLD}/scratchpad/run.log`]: minutesAgo(300),
    });
    expect(loop.verdict).toBe('reap');
    expect(loop.foreign).toBe(true);
  });

  it("reaps a cleared session's loop on an empty task file", () => {
    const [loop] = run([row(1, 5 * 3600, taskLoop(OLD))], {
      [`${TMP}/${OLD}/tasks/b1.output`]: minutesAgo(300),
    });
    expect(loop.verdict).toBe('reap');
  });

  it("leaves a cleared session's loop alone while its log is still growing", () => {
    expect(
      run([row(1, 5 * 3600, scratchLoop(OLD))], {
        [`${TMP}/${OLD}/scratchpad/run.log`]: minutesAgo(2),
      }),
    ).toEqual([]);
  });

  it("only flags this session's own stuck loop until it is 3h old", () => {
    const quiet = { [`${TMP}/${CUR}/scratchpad/run.log`]: minutesAgo(90) };
    expect(run([row(1, 3600, scratchLoop(CUR))], quiet)[0].verdict).toBe('suspect');
    expect(run([row(1, 4 * 3600, scratchLoop(CUR))], quiet)[0].verdict).toBe('reap');
  });

  it('reaps anything past 12h, even with a fresh log', () => {
    const [loop] = run([row(1, 13 * 3600, scratchLoop(CUR))], {
      [`${TMP}/${CUR}/scratchpad/run.log`]: minutesAgo(1),
    });
    expect(loop.verdict).toBe('reap');
  });

  it("ignores other claude processes' shells, non-loops, and young loops", () => {
    expect(
      run([
        row(1, 5 * 3600, scratchLoop(OLD), 999),
        row(2, 5 * 3600, `${SHELL}npm run dev${TAIL}`),
        row(3, 10 * 60, scratchLoop(OLD)),
      ]),
    ).toEqual([]);
  });
});
