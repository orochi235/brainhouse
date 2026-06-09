import type { Event } from '@server/parser.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViewItem } from '../lib/pipeline-types.ts';
import type { Stage2TraceRecord } from './runner.ts';
import type { TraceRecord } from './selectors/types.ts';
import { type SnapshotInput, serializeDebugSnapshot, serializeDebugSnapshotJson } from './snapshot.ts';

function fixtureInput(): SnapshotInput {
  const event: Event = {
    uuid: 'e_b1c2',
    parent_uuid: null,
    session_id: 'p_8f3a',
    agent_id: null,
    ts: '2026-06-08T14:22:00Z',
    cwd: null,
    kind: 'user_text',
    payload: { text: 'hello there' },
  } as Event;

  const record: TraceRecord = {
    eventUuid: 'e_b1c2',
    perStage: [
      { transformKey: 'stripBhTitleMarker', matched: true, ran: true, consumed: false, mutatedItems: true },
      { transformKey: 'tagBtwUserText', matched: true, ran: true, consumed: false, mutatedItems: true },
      { transformKey: 'bashTerminal', matched: false, ran: false, consumed: false, mutatedItems: false },
      { transformKey: 'userTextBubble', matched: true, ran: true, consumed: true, mutatedItems: true },
    ],
    finalItemIndices: [0],
  };

  const stage2: Stage2TraceRecord[] = [
    { transformKey: 'coalesceAdjacentBubbles', ran: true, mutatedItems: true, beforeLen: 214, afterLen: 211 },
  ];

  const items: ViewItem[] = [
    {
      type: 'bubble',
      event,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello there' }],
    },
  ];

  return {
    panelId: 'p_8f3a',
    event,
    eventIndex: 47,
    eventTotal: 213,
    capturedAt: new Date('2026-06-08T14:22:11.000Z'),
    record,
    stage2,
    items,
    toggles: { toolUseCapsule: false, subagentBanner: false },
  };
}

describe('serializeDebugSnapshot', () => {
  it('matches the golden Markdown byte-for-byte', () => {
    const out = serializeDebugSnapshot(fixtureInput());
    const golden = readFileSync(
      resolve(__dirname, '__fixtures__/snapshot.golden.md'),
      'utf-8',
    );
    expect(out).toBe(golden);
  });
});

describe('serializeDebugSnapshotJson', () => {
  it('produces parseable JSON with the expected top-level keys', () => {
    const out = serializeDebugSnapshotJson(fixtureInput());
    const obj = JSON.parse(out);
    expect(Object.keys(obj).sort()).toEqual(
      [
        'capturedAt',
        'event',
        'eventIndex',
        'eventTotal',
        'finalItems',
        'panelId',
        'runnerVersion',
        'stage1',
        'stage2',
        'toggles',
      ].sort(),
    );
    expect(obj.panelId).toBe('p_8f3a');
    expect(obj.stage1).toHaveLength(4);
  });
});
