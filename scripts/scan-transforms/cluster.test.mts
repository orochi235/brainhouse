import type { Event } from '../../server/src/parser.ts';
import { describe, expect, it } from 'vitest';
import { clusterKey } from './cluster.mts';

function ev(partial: Partial<Event> & Pick<Event, 'kind' | 'payload'>): Event {
  return {
    session_id: 's', agent_id: null, uuid: 'u', parent_uuid: null,
    ts: '2026-06-20T00:00:00Z', cwd: null, tags: [],
    ...partial,
  } as Event;
}

describe('clusterKey', () => {
  it('keys tool_use by kind + tool name', () => {
    const k = clusterKey(ev({ kind: 'tool_use', payload: { tool_use_id: 't', name: 'NewTool', input: {} } }));
    expect(k).toBe('tool_use|NewTool');
  });
  it('keys text events by kind + detected markers', () => {
    const k = clusterKey(ev({ kind: 'assistant_text', payload: { text: 'hi <new-marker>stuff</new-marker>' } }));
    expect(k).toBe('assistant_text|<new-marker');
  });
  it('keys markerless text by kind alone', () => {
    expect(clusterKey(ev({ kind: 'assistant_text', payload: { text: 'plain' } }))).toBe('assistant_text|');
  });
  it('keys other kinds by kind', () => {
    expect(clusterKey(ev({ kind: 'system', payload: { subtype: null, content: null, level: null } }))).toBe('system|');
  });
});
