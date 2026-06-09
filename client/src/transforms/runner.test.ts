/**
 * Tests for runner instrumentation introduced in Spec 3 (live trace + toggles).
 * The pipeline behavior itself is covered by `../lib/pipeline.test.ts` — these
 * tests cover only the trace accumulator + toggle short-circuit + mutation
 * heuristic the runner gained.
 */

import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { runViewPipeline, type TraceAccumulator } from './runner.ts';
import type { Stage1Transform, Stage2Transform, ViewTransform } from './types.ts';

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

function newAcc(): TraceAccumulator {
  return { perEvent: [], stage2: [] };
}

// Tiny custom transforms for hermetic testing.
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

describe('runViewPipeline trace', () => {
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
    // The pass-through transform should report mutatedItems: false.
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
    // pushOne emits a meta item per event whose event.uuid matches.
    const uuids = items.map((i: ViewItem) =>
      (i as { event?: { uuid?: string } }).event?.uuid,
    );
    expect(uuids).toEqual([events[0]?.uuid, events[1]?.uuid]);
    expect(trace.perEvent[0]?.finalItemIndices).toEqual([0]);
    expect(trace.perEvent[1]?.finalItemIndices).toEqual([1]);
  });
});
