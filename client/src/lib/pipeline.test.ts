import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import { extractLastChecklist, preprocessEvents } from './pipeline.ts';

let uid = 0;
function ev<K extends Event['kind']>(
  kind: K,
  payload: Extract<Event, { kind: K }>['payload'],
): Event {
  uid += 1;
  return {
    kind,
    payload,
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 's1',
    agent_id: null,
    ts: '2026-05-19T00:00:00Z',
    cwd: null,
  } as Event;
}

const userText = (text: string) => ev('user_text', { text });
const asstText = (text: string) => ev('assistant_text', { text });
const toolUse = (id: string, name = 'Bash', input: unknown = {}) =>
  ev('tool_use', { tool_use_id: id, name, input });
const toolResult = (id: string, content: unknown = 'ok', is_error = false) =>
  ev('tool_result', { tool_use_id: id, content, is_error });

describe('preprocessEvents', () => {
  it('user text becomes a user bubble', () => {
    const { items } = preprocessEvents([userText('hi')]);
    expect(items).toEqual([
      expect.objectContaining({
        type: 'bubble',
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
      }),
    ]);
  });

  it('assistant text becomes an assistant bubble', () => {
    const { items } = preprocessEvents([userText('hi'), asstText('hello back')]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: 'bubble', role: 'assistant' });
  });

  it('tool_use + matching tool_result merge into one tool item', () => {
    const { items } = preprocessEvents([toolUse('t1', 'Bash'), toolResult('t1', 'out')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'tool',
      use: { tool_use_id: 't1' },
      result: { content: 'out' },
    });
  });

  it('orphan tool_result renders as tool item with no use', () => {
    const { items } = preprocessEvents([toolResult('missing', 'x')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'tool', use: null, result: { content: 'x' } });
  });

  it('tool_use upgrades a prior orphan rather than duplicating', () => {
    const { items } = preprocessEvents([toolResult('t1', 'r'), toolUse('t1', 'Read')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'tool',
      use: { tool_use_id: 't1', name: 'Read' },
      result: { content: 'r' },
    });
  });

  it('short assistant text after a tool folds in as ack', () => {
    const { items } = preprocessEvents([toolUse('t1', 'Bash'), toolResult('t1'), asstText('done')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'tool', ack: 'done' });
  });

  it('long assistant text after a tool is a real bubble, not an ack', () => {
    const long = `${'a'.repeat(150)}\n\nmore`;
    const { items } = preprocessEvents([toolUse('t1'), toolResult('t1'), asstText(long)]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: 'bubble', role: 'assistant' });
  });

  it('suppresses the interrupt marker and folds the follow-up into the prior user bubble', () => {
    const { items } = preprocessEvents([
      userText('write a poem'),
      userText('[Request interrupted by user]'),
      userText('actually, a haiku'),
    ]);
    expect(items).toHaveLength(1);
    const bubble = items[0];
    if (bubble?.type !== 'bubble') throw new Error('expected bubble');
    expect(bubble.parts).toEqual([
      { kind: 'text', text: 'write a poem' },
      { kind: 'sawtooth' },
      { kind: 'text', text: 'actually, a haiku' },
    ]);
  });

  it('pending=true after user_text awaiting assistant', () => {
    const { pending } = preprocessEvents([userText('hi')]);
    expect(pending).toBe(true);
  });

  it('pending=false after assistant replies', () => {
    const { pending } = preprocessEvents([userText('hi'), asstText('hello')]);
    expect(pending).toBe(false);
  });

  it('pending=true after a tool_result awaiting the next assistant turn', () => {
    const { pending } = preprocessEvents([
      userText('go'),
      asstText('sure'),
      toolUse('t1'),
      toolResult('t1'),
    ]);
    expect(pending).toBe(true);
  });

  it('routes thinking/system/meta into their own item types', () => {
    // Sandwich them with bubbles so the between-chats collapse doesn't
    // wrap them into a single op-strip.
    const { items } = preprocessEvents([
      userText('a'),
      ev('thinking', { text: 'hmm' }),
      asstText(`a long enough message\n\nto avoid folding as an ack`),
      ev('system', { subtype: null, content: 'note', level: null }),
      userText('b'),
      ev('meta', { raw: {} }),
      asstText(`another long enough message\n\nto avoid folding`),
    ]);
    const kinds = items.map((i) => i.type);
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('system');
    expect(kinds).toContain('meta');
  });

  it('coalesces consecutive file ops on the same path into a file-change item', () => {
    const { items } = preprocessEvents([
      toolUse('t1', 'Read', { file_path: '/a.ts' }),
      toolResult('t1', 'contents'),
      toolUse('t2', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      toolResult('t2', 'edited'),
      toolUse('t3', 'Write', { file_path: '/a.ts', content: 'new content' }),
      toolResult('t3', 'wrote'),
    ]);
    expect(items).toHaveLength(1);
    const fc = items[0];
    if (fc?.type !== 'file-change') throw new Error('expected file-change');
    expect(fc.path).toBe('/a.ts');
    expect(fc.ops).toHaveLength(3);
    expect(fc.ops.map((o) => o.use?.name)).toEqual(['Read', 'Edit', 'Write']);
  });

  it('a chat bubble between file ops breaks the run', () => {
    const { items } = preprocessEvents([
      toolUse('t1', 'Read', { file_path: '/a.ts' }),
      toolResult('t1'),
      userText('look at this'),
      toolUse('t2', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      toolResult('t2'),
      toolUse('t3', 'Write', { file_path: '/a.ts', content: 'z' }),
      toolResult('t3'),
    ]);
    // Read alone (no coalesce of 1), bubble, then Edit+Write coalesced.
    expect(items.map((i) => i.type)).toEqual(['tool', 'bubble', 'file-change']);
    const fc = items[2];
    if (fc?.type !== 'file-change') throw new Error('expected file-change');
    expect(fc.ops).toHaveLength(2);
  });

  it('ops on different paths do not coalesce', () => {
    // Bubbles surround the ops so the between-chats collapse leaves them alone.
    const { items } = preprocessEvents([
      userText('look'),
      toolUse('t1', 'Read', { file_path: '/a.ts' }),
      toolResult('t1'),
      toolUse('t2', 'Edit', { file_path: '/b.ts', old_string: 'x', new_string: 'y' }),
      toolResult('t2'),
      asstText(`a longer reply\n\nwith two paragraphs so it does not fold as an ack`),
    ]);
    // Between bubbles there are 2 ops on different paths → no file-change
    // collapse, then between-chats coalesces them into an op-strip.
    expect(items.map((i) => i.type)).toEqual(['bubble', 'op-strip', 'bubble']);
    const strip = items[1];
    if (strip?.type !== 'op-strip') throw new Error('expected op-strip');
    expect(strip.items.map((i) => i.type)).toEqual(['tool', 'tool']);
  });

  it('non-file tools do not get folded in', () => {
    const { items } = preprocessEvents([
      userText('look'),
      toolUse('t1', 'Read', { file_path: '/a.ts' }),
      toolResult('t1'),
      toolUse('t2', 'Bash', { command: 'ls' }),
      toolResult('t2'),
      toolUse('t3', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      toolResult('t3'),
      asstText(`a longer reply\n\nwith two paragraphs so it does not fold as an ack`),
    ]);
    // Read and Edit on the same file are separated by a Bash → no file-change
    // collapse; between-chats wraps the 3 capsules.
    const strip = items[1];
    if (strip?.type !== 'op-strip') throw new Error('expected op-strip');
    expect(strip.items.map((i) => i.type)).toEqual(['tool', 'tool', 'tool']);
  });

  it('pending op (no result yet) is left un-coalesced', () => {
    const { items } = preprocessEvents([
      toolUse('t1', 'Read', { file_path: '/a.ts' }),
      toolResult('t1'),
      toolUse('t2', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      // no toolResult for t2 → pending
    ]);
    // Read finished + Edit pending; both stay as tool items (no coalesce of 1).
    expect(items.map((i) => i.type)).toEqual(['tool', 'tool']);
  });

  it('coalesces multiple non-chat ops between chats into an op-strip', () => {
    const { items } = preprocessEvents([
      userText('go'),
      toolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1'),
      toolUse('t2', 'Grep', { pattern: 'foo' }),
      toolResult('t2'),
      toolUse('t3', 'Bash', { command: 'pwd' }),
      toolResult('t3'),
      asstText(`all done\n\nhere is what happened`),
    ]);
    expect(items.map((i) => i.type)).toEqual(['bubble', 'op-strip', 'bubble']);
    const strip = items[1];
    if (strip?.type !== 'op-strip') throw new Error('expected op-strip');
    expect(strip.items).toHaveLength(3);
  });

  it('a single op between chats does not collapse', () => {
    const { items } = preprocessEvents([
      userText('go'),
      toolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1'),
      // Long-enough reply so it doesn't fold as an ack on the tool capsule.
      asstText(`here is the listing\n\nas requested in your prompt`),
    ]);
    expect(items.map((i) => i.type)).toEqual(['bubble', 'tool', 'bubble']);
  });

  it('a single op followed by a short ack stays as one tool item', () => {
    const { items } = preprocessEvents([
      userText('go'),
      toolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1'),
      asstText('done'),
    ]);
    expect(items.map((i) => i.type)).toEqual(['bubble', 'tool']);
  });

  it('a pending tool stays on its own line', () => {
    const { items } = preprocessEvents([
      userText('go'),
      toolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1'),
      toolUse('t2', 'Bash', { command: 'pwd' }),
      // no result for t2 → pending
    ]);
    // Both tools sit alone; the pending tool stays visible, and the finished
    // one before it doesn't get to coalesce into a singleton-only strip.
    expect(items.map((i) => i.type)).toEqual(['bubble', 'tool', 'tool']);
  });

  it('an op-strip can wrap a file-change item alongside other tools', () => {
    const { items } = preprocessEvents([
      userText('go'),
      toolUse('t1', 'Read', { file_path: '/a.ts' }),
      toolResult('t1'),
      toolUse('t2', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      toolResult('t2'),
      toolUse('t3', 'Bash', { command: 'pwd' }),
      toolResult('t3'),
      asstText('done'),
    ]);
    // File ops collapse to file-change, then strip wraps it + the Bash tool.
    const strip = items[1];
    if (strip?.type !== 'op-strip') throw new Error('expected op-strip');
    expect(strip.items.map((i) => i.type)).toEqual(['file-change', 'tool']);
  });

  it('drops panel-metadata meta records (subagent-meta, custom-title, agent-name)', () => {
    const { items } = preprocessEvents([
      ev('meta', { record_type: 'subagent-meta', raw: {} }),
      ev('meta', { record_type: 'custom-title', raw: {} }),
      ev('meta', { record_type: 'agent-name', raw: {} }),
      ev('meta', { record_type: 'something-else', raw: {} }),
    ]);
    expect(items.map((i) => i.type)).toEqual(['meta']);
  });

  it('extracts the most recent brainhouse-checklist block', () => {
    const text = [
      '```brainhouse-checklist',
      '- [x] first',
      '- [ ] second',
      '```',
      'later:',
      '```brainhouse-checklist',
      '- [x] done',
      '- [x] also done',
      '```',
    ].join('\n');
    const { checklist } = preprocessEvents([asstText(text)]);
    expect(checklist).toEqual([
      { done: true, text: 'done' },
      { done: true, text: 'also done' },
    ]);
  });

  describe('interrupt marker → canceled turn', () => {
    const interrupt = () => userText('[Request interrupted by user]');

    it('marks the in-flight assistant bubble as canceled', () => {
      const { items } = preprocessEvents([
        userText('explain quicksort'),
        asstText('Sure! Let me walk through it step by step…'),
        interrupt(),
        userText('actually nevermind'),
      ]);
      // mergeInterruptedFollowup folds the post-interrupt user_text into the
      // *previous* user bubble (with a sawtooth tear), so the final list is
      // [user-bubble-with-followup, asst-bubble (canceled)].
      const asst = items.find(
        (i): i is Extract<typeof i, { type: 'bubble' }> =>
          i.type === 'bubble' && i.role === 'assistant',
      );
      if (!asst) throw new Error('expected asst bubble');
      expect(asst.canceled).toBe(true);
    });

    it('marks tools/capsules between the last user and the interrupt as canceled', () => {
      const { items } = preprocessEvents([
        userText('count to 10'),
        toolUse('t1', 'Bash'),
        toolResult('t1'),
        interrupt(),
        userText('stop'),
      ]);
      const tool = items.find((i) => i.type === 'tool');
      if (!tool || tool.type !== 'tool') throw new Error('missing tool item');
      expect(tool.canceled).toBe(true);
    });

    it('does not bleed across an earlier canceled boundary', () => {
      const { items } = preprocessEvents([
        userText('q1'),
        asstText('a1'),
        interrupt(),
        userText('q2'),
        asstText('a2'),
      ]);
      // First asst canceled, second asst not.
      const assts = items.filter(
        (i): i is Extract<typeof i, { type: 'bubble' }> =>
          i.type === 'bubble' && i.role === 'assistant',
      );
      expect(assts.length).toBe(2);
      expect(assts[0]?.canceled).toBe(true);
      expect(assts[1]?.canceled).toBeFalsy();
    });
  });

  describe('AskUserQuestion → assistant bubble', () => {
    it('renders the question + options as a synthetic assistant bubble', () => {
      const { items } = preprocessEvents([
        userText('pick one'),
        toolUse('q1', 'AskUserQuestion', {
          questions: [
            {
              question: 'Which db?',
              header: 'DB',
              multiSelect: false,
              options: [
                { label: 'Postgres', description: 'OLTP workhorse' },
                { label: 'SQLite', description: 'local-first' },
              ],
            },
          ],
        }),
      ]);
      // user bubble + synthetic asst bubble, no tool capsule
      expect(items.length).toBe(2);
      const asst = items[1];
      if (asst?.type !== 'bubble') throw new Error('expected asst bubble');
      expect(asst.role).toBe('assistant');
      const text = asst.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text).toContain('Which db?');
      expect(text).toContain('Postgres');
      expect(text).toContain('OLTP workhorse');
      expect(text).toContain('SQLite');
    });

    it('swallows the matching tool_result', () => {
      const { items } = preprocessEvents([
        toolUse('q1', 'AskUserQuestion', {
          questions: [{ question: 'go?', options: [{ label: 'yes' }] }],
        }),
        toolResult('q1', { answers: { go: 'yes' } }),
      ]);
      // Only the synthetic asst bubble — no orphan tool capsule from the result.
      expect(items.length).toBe(1);
      expect(items[0]?.type).toBe('bubble');
    });

    it('falls back to a normal tool capsule on a malformed payload', () => {
      const { items } = preprocessEvents([toolUse('q1', 'AskUserQuestion', { weird: true })]);
      expect(items.length).toBe(1);
      expect(items[0]?.type).toBe('tool');
    });

    it('multi-select questions are annotated', () => {
      const { items } = preprocessEvents([
        toolUse('q1', 'AskUserQuestion', {
          questions: [
            {
              question: 'pick any',
              multiSelect: true,
              options: [{ label: 'a' }, { label: 'b' }],
            },
          ],
        }),
      ]);
      const asst = items[0];
      if (asst?.type !== 'bubble') throw new Error('expected asst bubble');
      const text = asst.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text.toLowerCase()).toContain('pick any');
      // Multi-select hint should appear somewhere.
      expect(text).toMatch(/pick any/i);
    });
  });
});

describe('extractLastChecklist', () => {
  it('returns null with no fences', () => {
    expect(extractLastChecklist('plain text')).toBeNull();
  });

  it('parses checked + unchecked items', () => {
    const text = '```brainhouse-checklist\n- [x] a\n- [ ] b\n- [X] c\n```';
    expect(extractLastChecklist(text)).toEqual([
      { done: true, text: 'a' },
      { done: false, text: 'b' },
      { done: true, text: 'c' },
    ]);
  });

  it('returns null for an empty fence', () => {
    expect(extractLastChecklist('```brainhouse-checklist\n\n```')).toBeNull();
  });
});
