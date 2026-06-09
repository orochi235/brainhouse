import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import { preprocessEvents } from '../../lib/pipeline.ts';
import type { TerminalItem } from '../../lib/pipeline-types.ts';

let uid = 0;
function userText(text: string, ts = '2026-06-08T00:00:00Z'): Event {
  uid += 1;
  return {
    kind: 'user_text',
    payload: { text },
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 's1',
    agent_id: null,
    ts,
    cwd: null,
  } as Event;
}

describe('bashTerminal transform', () => {
  it('single event with <bash-input> + <bash-stdout> → one terminal item, one entry', () => {
    const text = '<bash-input>ls -la</bash-input>\n<bash-stdout>file.txt\n</bash-stdout>';
    const { items } = preprocessEvents([userText(text)]);
    expect(items).toHaveLength(1);
    const item = items[0] as TerminalItem;
    expect(item.type).toBe('terminal');
    expect(item.entries).toHaveLength(1);
    expect(item.entries[0]?.input).toBe('ls -la');
    expect(item.entries[0]?.stdout).toBe('file.txt');
    expect(item.entries[0]?.stderr).toBeNull();
    expect(item.entries[0]?.source).toBe('cli-bang');
  });

  it('two consecutive bash events coalesce into one item with two entries', () => {
    const a = userText('<bash-input>pwd</bash-input>\n<bash-stdout>/tmp</bash-stdout>');
    const b = userText('<bash-input>whoami</bash-input>\n<bash-stdout>mike</bash-stdout>');
    const { items } = preprocessEvents([a, b]);
    expect(items).toHaveLength(1);
    const item = items[0] as TerminalItem;
    expect(item.entries).toHaveLength(2);
    expect(item.entries[0]?.input).toBe('pwd');
    expect(item.entries[1]?.input).toBe('whoami');
  });

  it('a plain user_text between two bash events breaks the run', () => {
    const a = userText('<bash-input>pwd</bash-input>\n<bash-stdout>/tmp</bash-stdout>');
    const mid = userText('hello there');
    const b = userText('<bash-input>whoami</bash-input>\n<bash-stdout>mike</bash-stdout>');
    const { items } = preprocessEvents([a, mid, b]);
    expect(items.map((i) => i.type)).toEqual(['terminal', 'bubble', 'terminal']);
  });

  it('event with only <bash-stdout> has input:null and source:unknown', () => {
    const { items } = preprocessEvents([
      userText('<bash-stdout>just output\n</bash-stdout>'),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0] as TerminalItem;
    expect(item.entries[0]?.input).toBeNull();
    expect(item.entries[0]?.stdout).toBe('just output');
    expect(item.entries[0]?.source).toBe('unknown');
  });

  it('plain user_text falls through to the default bubble path', () => {
    const { items } = preprocessEvents([userText('regular message')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('bubble');
  });

  it('unknown <bash-foo> tag is captured under extras', () => {
    const text = '<bash-input>cmd</bash-input>\n<bash-foo>weird</bash-foo>';
    const { items } = preprocessEvents([userText(text)]);
    const item = items[0] as TerminalItem;
    expect(item.entries[0]?.extras).toEqual({ foo: 'weird' });
  });

  it('stderr tag populates the stderr field', () => {
    const text = '<bash-input>oops</bash-input>\n<bash-stderr>boom\n</bash-stderr>';
    const { items } = preprocessEvents([userText(text)]);
    const item = items[0] as TerminalItem;
    expect(item.entries[0]?.stderr).toBe('boom');
    expect(item.entries[0]?.stdout).toBeNull();
  });
});
