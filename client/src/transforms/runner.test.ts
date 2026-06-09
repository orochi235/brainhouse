/**
 * Runner tests cover:
 *  - selector dispatch (Spec 1): `matches` gating, "any" when matches is
 *    omitted, first-to-consume semantics, skipped transforms not blocking
 *    later ones.
 *  - trace + toggle instrumentation (Spec 3): per-event/per-stage records,
 *    mutation heuristic, error capture, isEnabled short-circuit, stage-2
 *    accumulator, finalItemIndices attribution.
 *
 * The pipeline behavior itself is covered by `../lib/pipeline.test.ts`.
 */

import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { F } from './selectors/__fixtures__/events.ts';
import { runViewPipeline, type TraceAccumulator } from './runner.ts';
import type { Stage1Transform, Stage2Transform, ViewTransform } from './types.ts';

function newAcc(): TraceAccumulator {
  return { perEvent: [], stage2: [] };
}

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

describe('runViewPipeline — trace seam (selectors)', () => {
  it('appends one TraceRecord per event with one perStage entry per stage-1 transform', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['tool-use.any'], false, log);
    const b = makeTransform('b', ['user-text.any'], true, log);
    const c = makeTransform('c', undefined, false, log);
    const trace = newAcc();
    runViewPipeline([F.userText, F.toolUseBash], { trace }, [a, b, c]);
    expect(trace.perEvent).toHaveLength(2);
    expect(trace.perEvent[0]?.eventUuid).toBe(F.userText.uuid);
    expect(
      trace.perEvent[0]?.perStage.map((p) => ({
        key: p.transformKey,
        matched: p.matched,
        ran: p.ran,
        consumed: p.consumed,
      })),
    ).toEqual([
      { key: 'a', matched: false, ran: false, consumed: false },
      { key: 'b', matched: true, ran: true, consumed: true },
      // c skipped because b consumed
    ]);
    expect(trace.perEvent[1]?.eventUuid).toBe(F.toolUseBash.uuid);
    expect(
      trace.perEvent[1]?.perStage.map((p) => ({
        key: p.transformKey,
        matched: p.matched,
        ran: p.ran,
        consumed: p.consumed,
      })),
    ).toEqual([
      { key: 'a', matched: true, ran: true, consumed: false },
      { key: 'b', matched: false, ran: false, consumed: false },
      { key: 'c', matched: true, ran: true, consumed: false },
    ]);
  });

  it('selectorKey populated when matches is declared, omitted when not', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['tool-use.any'], false, log);
    const c = makeTransform('c', undefined, false, log);
    const trace = newAcc();
    runViewPipeline([F.toolUseBash], { trace }, [a, c]);
    const stages = trace.perEvent[0]?.perStage ?? [];
    expect(stages[0]?.selectorKey).toBe('tool-use.any');
    expect(stages[1]?.selectorKey).toBeUndefined();
  });

  it('returns normal result when opts.trace is omitted (fast path)', () => {
    const log: string[] = [];
    const a = makeTransform('a', ['tool-use.any'], false, log);
    const result = runViewPipeline([F.toolUseBash], {}, [a]);
    expect(result.items).toEqual([]);
  });
});

// ---- Spec 3 instrumentation tests (synthetic events) ----

let uid = 0;
function ev<K extends Event['kind']>(
  kind: K,
  payload: Extract<Event, { kind: K }>['payload'],
  ts = '2026-05-19T00:00:00Z',
): Event {
  uid += 1;
  return {
    kind,
    payload,
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 's1',
    agent_id: null,
    ts,
    cwd: null,
  } as Event;
}
const userText = (text: string) => ev('user_text', { text });

const passthrough: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'passthrough',
  name: 'passthrough',
  description: 'never consumes, never mutates',
  run() {
    // no-op
  },
};
const pushOne: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'pushOne',
  name: 'pushOne',
  description: 'pushes a synthetic meta item for every event',
  run(event, items) {
    items.push({ type: 'meta', event });
    return true;
  },
};
const thrower: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'thrower',
  name: 'thrower',
  description: 'throws on every event',
  run() {
    throw new Error('boom');
  },
};
const dropAll: Stage2Transform = {
  kind: 'view',
  stage: 2,
  key: 'dropAll',
  name: 'dropAll',
  description: 'returns empty list',
  run() {
    return [];
  },
};
const stage2Noop: Stage2Transform = {
  kind: 'view',
  stage: 2,
  key: 'stage2Noop',
  name: 'stage2Noop',
  description: 'returns same items reference',
  run(items) {
    return items;
  },
};

describe('runViewPipeline — trace + toggles (Spec 3)', () => {
  it('returns identical items whether trace is present or not', () => {
    const events = [userText('hi'), userText('there')];
    const transforms: ViewTransform[] = [passthrough, pushOne];
    const without = runViewPipeline(events, {}, transforms).items;
    const trace = newAcc();
    const withT = runViewPipeline(events, { trace }, transforms).items;
    expect(withT).toEqual(without);
    expect(trace.perEvent).toHaveLength(2);
  });

  it('records one perStage entry up to and including the consumer', () => {
    const events = [userText('hi')];
    const trace = newAcc();
    runViewPipeline(events, { trace }, [passthrough, pushOne, pushOne]);
    expect(trace.perEvent[0]?.perStage.map((s) => s.transformKey)).toEqual([
      'passthrough',
      'pushOne',
    ]);
    expect(trace.perEvent[0]?.perStage[1]?.consumed).toBe(true);
    expect(trace.perEvent[0]?.perStage[1]?.mutatedItems).toBe(true);
    expect(trace.perEvent[0]?.perStage[0]?.mutatedItems).toBe(false);
  });

  it('captures errors and keeps subsequent stage-1 transforms running for the event', () => {
    const trace = newAcc();
    const events = [userText('a')];
    runViewPipeline(events, { trace }, [thrower, pushOne]);
    const stages = trace.perEvent[0]?.perStage ?? [];
    expect(stages[0]?.error?.message).toBe('boom');
    expect(stages[0]?.consumed).toBe(false);
    expect(stages[1]?.consumed).toBe(true);
  });

  it('toggle off skips run() and records ran:false', () => {
    const trace = newAcc();
    const events = [userText('a')];
    const { items } = runViewPipeline(
      events,
      { trace, isEnabled: (k) => k !== 'pushOne' },
      [pushOne],
    );
    expect(items).toEqual([]);
    expect(trace.perEvent[0]?.perStage[0]).toMatchObject({
      transformKey: 'pushOne',
      ran: false,
    });
  });

  it('mutation heuristic flags length change; misses in-place edits (documented)', () => {
    const trace = newAcc();
    runViewPipeline([userText('a')], { trace }, [passthrough, pushOne]);
    expect(trace.perEvent[0]?.perStage[0]?.mutatedItems).toBe(false);
    expect(trace.perEvent[0]?.perStage[1]?.mutatedItems).toBe(true);
  });

  it('stage-2 trace records beforeLen/afterLen and mutation', () => {
    const trace = newAcc();
    runViewPipeline([userText('a'), userText('b')], { trace }, [pushOne, dropAll, stage2Noop]);
    const s2 = trace.stage2;
    expect(s2.find((r) => r.transformKey === 'dropAll')).toMatchObject({
      ran: true,
      mutatedItems: true,
      beforeLen: 2,
      afterLen: 0,
    });
    expect(s2.find((r) => r.transformKey === 'stage2Noop')).toMatchObject({
      ran: true,
      mutatedItems: false,
      beforeLen: 0,
      afterLen: 0,
    });
  });

  it('finalItemIndices attributes by anchorUuid / event.uuid', () => {
    const trace = newAcc();
    const events = [userText('a'), userText('b')];
    const { items } = runViewPipeline(events, { trace }, [pushOne]);
    const uuids = items.map((i: ViewItem) => (i as { event?: { uuid?: string } }).event?.uuid);
    expect(uuids).toEqual([events[0]?.uuid, events[1]?.uuid]);
    expect(trace.perEvent[0]?.finalItemIndices).toEqual([0]);
    expect(trace.perEvent[1]?.finalItemIndices).toEqual([1]);
  });
});
