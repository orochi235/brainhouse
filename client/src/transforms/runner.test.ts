import { describe, expect, it } from 'vitest';
import { F } from './selectors/__fixtures__/events.ts';
import type { TraceRecord } from './selectors/types.ts';
import { runViewPipeline } from './runner.ts';
import type { Stage1Transform } from './types.ts';

function makeTransform(
  key: string,
  matches: string[] | undefined,
  consume: boolean,
  log: string[],
): Stage1Transform {
  return {
    kind: 'view',
    stage: 1,
    key,
    name: key,
    description: key,
    ...(matches ? { matches } : {}),
    run: (event) => {
      log.push(`${key}:${event.uuid}`);
      return consume;
    },
  };
}

describe('runViewPipeline — selector gating', () => {
  it('skips run() for events that match no listed selector', () => {
    const log: string[] = [];
    const t = makeTransform('only-tools', ['tool-use.any'], false, log);
    runViewPipeline([F.userText, F.toolUseBash], {}, [t]);
    // only the toolUseBash event should appear in the log
    expect(log).toEqual([`only-tools:${F.toolUseBash.uuid}`]);
  });

  it('runs unconditionally when matches is omitted', () => {
    const log: string[] = [];
    const t = makeTransform('any', undefined, false, log);
    runViewPipeline([F.userText, F.toolUseBash], {}, [t]);
    expect(log).toEqual([`any:${F.userText.uuid}`, `any:${F.toolUseBash.uuid}`]);
  });

  it('preserves first-to-consume stage-1 semantics', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['user-text.any'], true, log);
    const b = makeTransform('b', ['user-text.any'], true, log);
    runViewPipeline([F.userText], {}, [a, b]);
    expect(log).toEqual([`a:${F.userText.uuid}`]);
  });

  it('skipped transforms do not block subsequent transforms for that event', () => {
    const log: string[] = [];
    const onlyTools = makeTransform('only-tools', ['tool-use.any'], true, log);
    const onlyText = makeTransform('only-text', ['user-text.any'], true, log);
    runViewPipeline([F.userText], {}, [onlyTools, onlyText]);
    expect(log).toEqual([`only-text:${F.userText.uuid}`]);
  });
});

describe('runViewPipeline — trace seam', () => {
  it('appends one TraceRecord per event with one perStage entry per stage-1 transform', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['tool-use.any'], false, log);
    const b = makeTransform('b', ['user-text.any'], true, log);
    const c = makeTransform('c', undefined, false, log);
    const trace: TraceRecord[] = [];
    runViewPipeline([F.userText, F.toolUseBash], { trace }, [a, b, c]);
    expect(trace).toHaveLength(2);
    expect(trace[0]?.eventUuid).toBe(F.userText.uuid);
    expect(trace[0]?.perStage.map((p) => ({ key: p.transformKey, matched: p.matched, ran: p.ran, consumed: p.consumed }))).toEqual([
      { key: 'a', matched: false, ran: false, consumed: false },
      { key: 'b', matched: true, ran: true, consumed: true },
      // c skipped because b consumed
    ]);
    expect(trace[1]?.eventUuid).toBe(F.toolUseBash.uuid);
    expect(trace[1]?.perStage.map((p) => ({ key: p.transformKey, matched: p.matched, ran: p.ran, consumed: p.consumed }))).toEqual([
      { key: 'a', matched: true, ran: true, consumed: false },
      { key: 'b', matched: false, ran: false, consumed: false },
      { key: 'c', matched: true, ran: true, consumed: false },
    ]);
  });

  it('selectorKey populated when matches is declared, omitted when not', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['tool-use.any'], false, log);
    const c = makeTransform('c', undefined, false, log);
    const trace: TraceRecord[] = [];
    runViewPipeline([F.toolUseBash], { trace }, [a, c]);
    const stages = trace[0]?.perStage ?? [];
    expect(stages[0]?.selectorKey).toBe('tool-use.any');
    expect(stages[1]?.selectorKey).toBeUndefined();
  });

  it('no trace allocations when opts.trace is omitted (fast path returns normal result)', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['tool-use.any'], false, log);
    const result = runViewPipeline([F.toolUseBash], {}, [a]);
    expect(result.items).toEqual([]); // a didn't push anything
  });
});
