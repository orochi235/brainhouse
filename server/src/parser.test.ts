import { describe, expect, it } from 'vitest';
import { parseLine } from './parser.js';

describe('parseLine', () => {
  it('user string content → single user_text', () => {
    const events = parseLine({
      type: 'user',
      uuid: 'u1',
      parentUuid: 'p0',
      sessionId: 's1',
      timestamp: '2026-04-27T17:12:39.512Z',
      message: { role: 'user', content: 'hello' },
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e?.kind).toBe('user_text');
    expect(e?.payload).toEqual({ text: 'hello' });
    expect(e?.session_id).toBe('s1');
    expect(e?.uuid).toBe('u1');
  });

  it('assistant text block', () => {
    const events = parseLine({
      type: 'assistant',
      uuid: 'u2',
      sessionId: 's1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'text', text: 'writing the doc now.' }] },
    });
    expect(events.map((e) => e.kind)).toEqual(['assistant_text']);
    expect(events[0]?.payload).toMatchObject({ text: 'writing the doc now.' });
  });

  it('assistant thinking + text + tool_use fans out into three events', () => {
    const events = parseLine({
      type: 'assistant',
      uuid: 'u3',
      sessionId: 's1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'consider...', signature: 'x' },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'assistant_text', 'tool_use']);
    expect(events[0]?.payload).toMatchObject({ text: 'consider...' });
    expect(events[2]?.payload).toEqual({
      tool_use_id: 'toolu_abc',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(new Set(events.map((e) => e.uuid)).size).toBe(3);
  });

  it('tool_result inside a user message', () => {
    const events = parseLine({
      type: 'user',
      uuid: 'u4',
      sessionId: 's1',
      timestamp: 't',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'total 0\n' }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('tool_result');
    expect(events[0]?.payload).toMatchObject({ tool_use_id: 'toolu_abc', is_error: false });
  });

  it('system local_command record', () => {
    const events = parseLine({
      type: 'system',
      uuid: 'u5',
      sessionId: 's1',
      timestamp: 't',
      subtype: 'local_command',
      content: '<command-name>/color</command-name>',
      level: 'info',
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e?.kind).toBe('system');
    expect(e?.payload).toMatchObject({ subtype: 'local_command', level: 'info' });
  });

  it('metadata record without session uses fallback', () => {
    const events = parseLine(
      {
        type: 'file-history-snapshot',
        messageId: 'm1',
        snapshot: { trackedFileBackups: {} },
        isSnapshotUpdate: false,
      },
      { session_id: 's-fallback' },
    );
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e?.kind).toBe('meta');
    expect(e?.session_id).toBe('s-fallback');
    if (e?.kind === 'meta') {
      expect(e.payload.record_type).toBe('file-history-snapshot');
    }
  });

  it('subagent record carries its own agentId', () => {
    const events = parseLine({
      type: 'user',
      isSidechain: true,
      agentId: 'agent-abc',
      uuid: 'u6',
      sessionId: 'parent-session',
      timestamp: 't',
      message: { role: 'user', content: 'go find X' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.agent_id).toBe('agent-abc');
    expect(events[0]?.session_id).toBe('parent-session');
    expect(events[0]?.kind).toBe('user_text');
  });

  it('agent_id fallback when record omits it', () => {
    const events = parseLine(
      {
        type: 'assistant',
        uuid: 'u7',
        sessionId: 's1',
        timestamp: 't',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
      { agent_id: 'agent-fallback' },
    );
    expect(events[0]?.agent_id).toBe('agent-fallback');
  });

  it('unknown block type becomes a meta event', () => {
    const events = parseLine({
      type: 'assistant',
      uuid: 'u8',
      sessionId: 's1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'future_block_type', foo: 'bar' }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('meta');
    if (events[0]?.kind === 'meta') {
      expect(events[0].payload.block_type).toBe('future_block_type');
    }
  });

  it('session metadata records pass through as meta', () => {
    const events = parseLine({
      type: 'pr-link',
      sessionId: 's1',
      prNumber: 107,
      prUrl: 'https://example/pr/107',
      timestamp: 't',
    });
    expect(events[0]?.kind).toBe('meta');
    if (events[0]?.kind === 'meta') {
      expect(events[0].payload.record_type).toBe('pr-link');
      const raw = events[0].payload.raw as Record<string, unknown>;
      expect(raw.prNumber).toBe(107);
    }
  });

  it('non-list / non-string content yields no events', () => {
    const events = parseLine({
      type: 'user',
      uuid: 'u9',
      sessionId: 's1',
      timestamp: 't',
      message: { role: 'user', content: null },
    });
    expect(events).toEqual([]);
  });
});
