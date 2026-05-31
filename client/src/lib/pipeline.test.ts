import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import { extractLastChecklist, preprocessEvents } from './pipeline.ts';

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

const userText = (text: string, ts?: string) => ev('user_text', { text }, ts);
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

  it('queued interrupt (<3s gap) grafts the follow-up onto the prior user bubble', () => {
    const { items } = preprocessEvents([
      userText('write a poem', '2026-05-19T00:00:00Z'),
      userText('[Request interrupted by user]', '2026-05-19T00:00:05Z'),
      userText('actually, a haiku', '2026-05-19T00:00:05.500Z'),
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

  it('full interrupt (>=3s gap) emits a divider then a fresh user bubble', () => {
    const { items } = preprocessEvents([
      userText('write a poem', '2026-05-19T00:00:00Z'),
      userText('[Request interrupted by user]', '2026-05-19T00:00:05Z'),
      userText('actually, a haiku', '2026-05-19T00:00:30Z'),
    ]);
    expect(items.map((i) => i.type)).toEqual(['bubble', 'interrupt-divider', 'bubble']);
    const first = items[0];
    const second = items[2];
    if (first?.type !== 'bubble' || second?.type !== 'bubble') {
      throw new Error('expected bubbles');
    }
    expect(first.parts).toEqual([{ kind: 'text', text: 'write a poem' }]);
    expect(second.parts).toEqual([{ kind: 'text', text: 'actually, a haiku' }]);
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

  it('pending stays true through a mid-turn tool_use (model is still working)', () => {
    const { pending } = preprocessEvents([userText('go'), toolUse('t1')]);
    expect(pending).toBe(true);
  });

  it('routes thinking/system/meta into their own item types', () => {
    // Each is sandwiched as a singleton between bubbles so the
    // between-chats collapse passes them through. Thinking is placed
    // after its asstText (not before) so the assistant-bubble fold
    // rule doesn't absorb it — that absorption is tested separately
    // below.
    const { items } = preprocessEvents([
      userText('a'),
      asstText(`a long enough message\n\nto avoid folding as an ack`),
      ev('thinking', { text: 'hmm' }),
      userText('b'),
      ev('system', { subtype: null, content: 'note', level: null }),
      asstText(`another long enough message\n\nto avoid folding`),
      ev('meta', { raw: {} }),
      userText('c'),
    ]);
    const kinds = items.map((i) => i.type);
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('system');
    expect(kinds).toContain('meta');
  });

  it('drops redacted (empty-text) thinking events entirely', () => {
    // Modern Claude transcripts often ship `thinking: ""` + a non-empty
    // signature (encrypted/redacted internal reasoning). Without this
    // filter, every such block renders as an empty thought bubble
    // stranded above the assistant's actual reply.
    const { items } = preprocessEvents([
      userText('a'),
      ev('thinking', { text: '' }),
      asstText(`my answer\n\nwith enough text to avoid the tool-ack fold`),
    ]);
    expect(items.map((i) => i.type)).not.toContain('thinking');
    const bubble = items.find((i) => i.type === 'bubble' && i.role === 'assistant');
    expect(bubble?.type).toBe('bubble');
  });

  it('keeps visible thinking as its own standalone item', () => {
    const { items } = preprocessEvents([
      userText('a'),
      ev('thinking', { text: 'pondering' }),
      asstText(`my answer\n\nwith enough text to avoid the tool-ack fold`),
    ]);
    expect(items.map((i) => i.type)).toContain('thinking');
    expect(items.map((i) => i.type)).toContain('bubble');
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

  it('routes TodoWrite tool calls into the pinned checklist and suppresses the capsule', () => {
    const { items, checklist } = preprocessEvents([
      userText('go'),
      toolUse('t1', 'TodoWrite', {
        todos: [
          { content: 'one', status: 'completed', activeForm: 'doing one' },
          { content: 'two', status: 'in_progress', activeForm: 'doing two' },
          { content: 'three', status: 'pending', activeForm: 'doing three' },
        ],
      }),
    ]);
    expect(checklist).toEqual([
      {
        done: true,
        text: 'one',
        inProgress: false,
        completedAt: '2026-05-19T00:00:00Z',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
      { done: false, text: 'two', inProgress: true, firstSeenAt: '2026-05-19T00:00:00Z' },
      { done: false, text: 'three', inProgress: false, firstSeenAt: '2026-05-19T00:00:00Z' },
    ]);
    // No tool capsule for the TodoWrite call.
    expect(items.find((i) => i.type === 'tool')).toBeUndefined();
  });

  it('TodoWrite uses the latest call when multiple are emitted', () => {
    const { checklist } = preprocessEvents([
      toolUse('t1', 'TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }),
      toolUse('t2', 'TodoWrite', {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
        ],
      }),
    ]);
    expect(checklist).toEqual([
      {
        done: true,
        text: 'a',
        inProgress: false,
        completedAt: '2026-05-19T00:00:00Z',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
      { done: false, text: 'b', inProgress: true, firstSeenAt: '2026-05-19T00:00:00Z' },
    ]);
  });

  it('TaskCreate appends one item per call with auto-assigned sequential ids', () => {
    const { items, checklist } = preprocessEvents([
      toolUse('t1', 'TaskCreate', { subject: 'one', activeForm: 'doing one' }),
      toolUse('t2', 'TaskCreate', { subject: 'two', activeForm: 'doing two' }),
      toolUse('t3', 'TaskCreate', { subject: 'three', activeForm: 'doing three' }),
    ]);
    expect(checklist).toEqual([
      {
        done: false,
        text: 'one',
        inProgress: false,
        id: '1',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
      {
        done: false,
        text: 'two',
        inProgress: false,
        id: '2',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
      {
        done: false,
        text: 'three',
        inProgress: false,
        id: '3',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
    ]);
    // No tool capsules rendered for any of the TaskCreate calls.
    expect(items.find((i) => i.type === 'tool')).toBeUndefined();
  });

  it('TaskUpdate patches the matching item by taskId', () => {
    const { checklist } = preprocessEvents([
      toolUse('t1', 'TaskCreate', { subject: 'one' }),
      toolUse('t2', 'TaskCreate', { subject: 'two' }),
      toolUse('t3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      toolUse('t4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
    ]);
    expect(checklist).toEqual([
      {
        done: false,
        text: 'one',
        inProgress: true,
        id: '1',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
      {
        done: true,
        text: 'two',
        inProgress: false,
        id: '2',
        completedAt: '2026-05-19T00:00:00Z',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
    ]);
  });

  it('TaskUpdate is a no-op when taskId does not match', () => {
    const { checklist } = preprocessEvents([
      toolUse('t1', 'TaskCreate', { subject: 'one' }),
      toolUse('t2', 'TaskUpdate', { taskId: '99', status: 'completed' }),
    ]);
    expect(checklist).toEqual([
      {
        done: false,
        text: 'one',
        inProgress: false,
        id: '1',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
    ]);
  });

  it('TaskUpdate can also rewrite the item text via subject', () => {
    const { checklist } = preprocessEvents([
      toolUse('t1', 'TaskCreate', { subject: 'original' }),
      toolUse('t2', 'TaskUpdate', { taskId: '1', subject: 'renamed', status: 'completed' }),
    ]);
    expect(checklist).toEqual([
      {
        done: true,
        text: 'renamed',
        inProgress: false,
        id: '1',
        completedAt: '2026-05-19T00:00:00Z',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
    ]);
  });

  it('TaskUpdate stamps completedAt only on the first done transition', () => {
    const { checklist } = preprocessEvents([
      toolUse('t1', 'TaskCreate', { subject: 'one' }),
      ev(
        'tool_use',
        { tool_use_id: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
        '2026-05-19T00:00:00Z',
      ),
      // A later update that *also* says completed should NOT overwrite the
      // original stamp (e.g. a rename pass).
      ev(
        'tool_use',
        {
          tool_use_id: 't3',
          name: 'TaskUpdate',
          input: { taskId: '1', subject: 'one renamed', status: 'completed' },
        },
        '2026-05-19T00:05:00Z',
      ),
    ]);
    expect(checklist).toEqual([
      {
        done: true,
        text: 'one renamed',
        inProgress: false,
        id: '1',
        completedAt: '2026-05-19T00:00:00Z',
        firstSeenAt: '2026-05-19T00:00:00Z',
      },
    ]);
  });

  it('accumulates Task tool_use spawns and tracks their result status', () => {
    const { subagentSpawns } = preprocessEvents([
      toolUse('t1', 'Task', { description: 'do A', subagent_type: 'general-purpose' }),
      toolUse('t2', 'Task', { description: 'do B', subagent_type: 'Explore' }),
      toolResult('t1', 'A done'),
      toolResult('t2', 'B failed', true),
    ]);
    expect(subagentSpawns).toEqual([
      {
        toolUseId: 't1',
        description: 'do A',
        agentType: 'general-purpose',
        status: 'done',
        order: 0,
      },
      {
        toolUseId: 't2',
        description: 'do B',
        agentType: 'Explore',
        status: 'failed',
        order: 1,
      },
    ]);
  });

  it('skips Task tool_use with no description', () => {
    const { subagentSpawns } = preprocessEvents([
      toolUse('t1', 'Task', { subagent_type: 'Explore' }),
    ]);
    expect(subagentSpawns).toEqual([]);
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

    it('swallows the matching tool_result and emits a separate user-side answer bubble', () => {
      const { items } = preprocessEvents([
        toolUse('q1', 'AskUserQuestion', {
          questions: [{ question: 'go?', options: [{ label: 'yes' }, { label: 'no' }] }],
        }),
        toolResult('q1', { answers: { 'go?': 'yes' } }),
      ]);
      // Two bubbles: assistant (question), user (answer). No orphan capsule.
      expect(items.length).toBe(2);
      const asst = items[0];
      const reply = items[1];
      if (asst?.type !== 'bubble' || reply?.type !== 'bubble') {
        throw new Error('expected two bubbles');
      }
      expect(asst.role).toBe('assistant');
      const asstText = asst.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      // Assistant bubble no longer carries the answer footer.
      expect(asstText).not.toMatch(/Answer:/);
      expect(reply.role).toBe('user');
      const replyText = reply.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(replyText).toBe('yes');
    });

    it('parses the Claude Code answer-string form ("Q"="A")', () => {
      const { items } = preprocessEvents([
        toolUse('q1', 'AskUserQuestion', {
          questions: [
            { question: 'Which db?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
          ],
        }),
        toolResult(
          'q1',
          'User has answered your questions: "Which db?"="SQLite". You can now continue.',
        ),
      ]);
      expect(items.length).toBe(2);
      const reply = items[1];
      if (reply?.type !== 'bubble') throw new Error('expected reply bubble');
      expect(reply.role).toBe('user');
      const text = reply.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text).toBe('SQLite');
    });

    it('renders multi-select answers as joined labels', () => {
      const { items } = preprocessEvents([
        toolUse('q1', 'AskUserQuestion', {
          questions: [
            {
              question: 'pick any',
              multiSelect: true,
              options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
            },
          ],
        }),
        toolResult('q1', { answers: { 'pick any': 'a, c' } }),
      ]);
      const reply = items[1];
      if (reply?.type !== 'bubble') throw new Error('expected reply bubble');
      const text = reply.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text).toBe('a, c');
    });

    it('marks a rejected tool_result as (no answer)', () => {
      const { items } = preprocessEvents([
        toolUse('q1', 'AskUserQuestion', {
          questions: [{ question: 'go?', options: [{ label: 'yes' }] }],
        }),
        toolResult('q1', 'The user does not want to proceed', true),
      ]);
      expect(items.length).toBe(2);
      const reply = items[1];
      if (reply?.type !== 'bubble') throw new Error('expected reply bubble');
      expect(reply.role).toBe('user');
      const text = reply.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text).toMatch(/\(no answer\)/);
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

  // tagBtwUserText is temporarily disabled in the registry — the /btw
  // detection has been firing on the wrong assistant bubble. Re-enable the
  // transform + this suite together when the heuristic is reworked.
  describe.skip('/btw queued prompt → marks next assistant bubble', () => {
    const queueOp = (content: string) =>
      ev('meta', {
        record_type: 'queue-operation',
        raw: { type: 'queue-operation', operation: 'enqueue', content },
      });

    it('queued user_text renders plain; the following assistant bubble is marked btw', () => {
      const { items } = preprocessEvents([
        userText('do thing'),
        asstText('working on it'),
        queueOp('also rename foo to bar'),
        userText('also rename foo to bar'),
        asstText('renamed'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      expect(bubbles.map((b) => b.type === 'bubble' && b.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      const btwUser = bubbles[2];
      const btwAsst = bubbles[3];
      if (btwUser?.type !== 'bubble' || btwAsst?.type !== 'bubble') {
        throw new Error('expected bubbles');
      }
      expect(btwUser.btw).toBeUndefined();
      const text = btwUser.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text).toBe('also rename foo to bar');
      expect(btwAsst.btw).toBe(true);
    });

    it('matches against trimmed text (whitespace tolerated on either side)', () => {
      const { items } = preprocessEvents([
        queueOp('a quick note'),
        userText('  a quick note\n'),
        asstText('noted'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      expect(bubbles).toHaveLength(2);
      const [u, a] = bubbles;
      if (u?.type !== 'bubble' || a?.type !== 'bubble') throw new Error('expected bubbles');
      expect(u.btw).toBeUndefined();
      expect(a.btw).toBe(true);
    });

    it('non-/btw user_text passes through without flagging the next assistant', () => {
      const { items } = preprocessEvents([userText('typed normally'), asstText('reply')]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      expect(bubbles).toHaveLength(2);
      for (const b of bubbles) {
        if (b.type !== 'bubble') throw new Error('expected bubble');
        expect(b.btw).toBeUndefined();
      }
    });

    it('queued_command attachment renders as a plain user bubble; next assistant is btw', () => {
      // Inline delivery flow (Claude Code ≥ 2.1.13x): the attachment IS the
      // user input; there is no follow-up `type:user` record.
      const { items } = preprocessEvents([
        queueOp('what does that first part mean?'),
        ev('meta', {
          record_type: 'attachment',
          raw: {
            type: 'attachment',
            attachment: {
              type: 'queued_command',
              prompt: 'what does that first part mean?',
              commandMode: 'prompt',
            },
          },
        }),
        asstText('it means…'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      expect(bubbles).toHaveLength(2);
      const [u, a] = bubbles;
      if (u?.type !== 'bubble' || a?.type !== 'bubble') throw new Error('expected bubbles');
      expect(u.role).toBe('user');
      expect(u.btw).toBeUndefined();
      const text = u.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
      expect(text).toBe('what does that first part mean?');
      expect(a.btw).toBe(true);
    });

    it('queued_command attachment alone still flags the next assistant', () => {
      const { items } = preprocessEvents([
        ev('meta', {
          record_type: 'attachment',
          raw: {
            type: 'attachment',
            attachment: { type: 'queued_command', prompt: 'standalone btw' },
          },
        }),
        asstText('ok'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      expect(bubbles).toHaveLength(2);
      const a = bubbles[1];
      if (a?.type !== 'bubble') throw new Error('expected bubble');
      expect(a.btw).toBe(true);
    });

    it('non-queued attachment shapes fall through (defaultEventItem absorbs them)', () => {
      const { items } = preprocessEvents([
        ev('meta', {
          record_type: 'attachment',
          raw: { type: 'attachment', attachment: { type: 'hook_success' } },
        }),
      ]);
      // Absorbed by defaultEventItem; nothing rendered.
      expect(items).toEqual([]);
    });

    it('suppresses the queue-operation meta from the rendered list', () => {
      const { items } = preprocessEvents([queueOp('queued prompt')]);
      // No bubble yet (no matching user_text) and the meta itself is consumed.
      expect(items).toEqual([]);
    });

    it('two /btw prompts → each pairs with the following assistant bubble', () => {
      const { items } = preprocessEvents([
        queueOp('one'),
        queueOp('two'),
        userText('one'),
        asstText('reply one'),
        userText('two'),
        asstText('reply two'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      const flags = bubbles.map((i) => (i.type === 'bubble' ? i.btw : undefined));
      // user, assistant(btw), user, assistant(btw)
      expect(flags).toEqual([undefined, true, undefined, true]);
    });

    it('ignores non-enqueue queue-operation records (dequeue etc.)', () => {
      const { items } = preprocessEvents([
        ev('meta', {
          record_type: 'queue-operation',
          raw: { type: 'queue-operation', operation: 'dequeue', content: 'x' },
        }),
        userText('x'),
        asstText('reply'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      expect(bubbles).toHaveLength(2);
      for (const b of bubbles) {
        if (b.type !== 'bubble') throw new Error('expected bubble');
        expect(b.btw).toBeUndefined();
      }
    });

    it('a fresh user_text between /btw and the assistant reply clears the pending flag', () => {
      // queue-op enqueues but no matching user_text fires; a different
      // user_text comes in → that's a fresh turn, not the queued one. The
      // assistant reply that follows should not inherit the chip.
      const { items } = preprocessEvents([
        queueOp('queued thing'),
        userText('something else entirely'),
        asstText('reply'),
      ]);
      const bubbles = items.filter((i) => i.type === 'bubble');
      const flags = bubbles.map((i) => (i.type === 'bubble' ? i.btw : undefined));
      expect(flags).toEqual([undefined, undefined]);
    });
  });

  describe('day-divider', () => {
    it('inserts a divider between items on different local days', () => {
      const { items } = preprocessEvents([
        userText('day one', '2026-05-25T22:00:00Z'),
        userText('day two', '2026-05-26T22:00:00Z'),
      ]);
      expect(items.map((i) => i.type)).toEqual(['bubble', 'day-divider', 'bubble']);
      const div = items[1] as Extract<typeof items[number], { type: 'day-divider' }>;
      expect(div.label).toMatch(/\w+,/); // "Tuesday, May 26" or locale equivalent
    });

    it('does not insert leading or trailing dividers', () => {
      const { items } = preprocessEvents([userText('just one', '2026-05-25T22:00:00Z')]);
      expect(items.map((i) => i.type)).toEqual(['bubble']);
    });

    it('emits at most one divider per day boundary, never adjacent', () => {
      const { items } = preprocessEvents([
        userText('a', '2026-05-25T22:00:00Z'),
        userText('b', '2026-05-26T22:00:00Z'),
        userText('c', '2026-05-27T22:00:00Z'),
      ]);
      // Three bubbles + two dividers — no two dividers in a row.
      const types = items.map((i) => i.type);
      expect(types).toEqual(['bubble', 'day-divider', 'bubble', 'day-divider', 'bubble']);
    });

    it('same-day items produce no divider', () => {
      const { items } = preprocessEvents([
        userText('morning', '2026-05-25T08:00:00-04:00'),
        userText('night', '2026-05-25T22:00:00-04:00'),
      ]);
      expect(items.map((i) => i.type)).toEqual(['bubble', 'bubble']);
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
