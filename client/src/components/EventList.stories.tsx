/**
 * Ladle stories for EventList — example transcripts wide enough to
 * exercise the pipeline transforms (bubbles, tool capsules, op-strips,
 * AskUserQuestion synthetic bubble, ctrl-c interrupt rendering, file
 * change coalescing). Each story is a single event stream; EventList
 * runs the same preprocessEvents() the live app uses.
 */

import type { Event, Tag } from '@server/parser.ts';
import { useEffect } from 'react';
import type React from 'react';
import { LightboxProvider } from '../lib/lightbox.tsx';
import { EventList } from './EventList.tsx';

let uid = 0;
function ev<K extends Event['kind']>(
  kind: K,
  payload: Extract<Event, { kind: K }>['payload'],
): Event {
  uid += 1;
  // Mirror parser tagging so transforms that classify via tags
  // (clearMarker, attachSkillPrelude, etc.) see the same shape they
  // would in production.
  const tags: Tag[] = [];
  if (kind === 'user_text') {
    const isMeta = (payload as { is_meta?: boolean }).is_meta === true;
    if (isMeta) tags.push('meta');
    else tags.push('dialogue');
  } else if (kind === 'assistant_text') tags.push('dialogue');
  else if (kind === 'thinking') tags.push('thinking');
  else if (kind === 'tool_use' || kind === 'tool_result') tags.push('tool');
  else if (kind === 'system') tags.push('system');
  else if (kind === 'resource_usage') tags.push('usage');
  else tags.push('meta');
  return {
    kind,
    payload,
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 'demo',
    agent_id: null,
    ts: '2026-05-20T00:00:00Z',
    cwd: null,
    tags,
  } as Event;
}

const userText = (text: string) => ev('user_text', { text });
const asstText = (text: string) => ev('assistant_text', { text });
const toolUse = (id: string, name: string, input: unknown = {}) =>
  ev('tool_use', { tool_use_id: id, name, input });
const toolResult = (id: string, content: unknown = 'ok', is_error = false) =>
  ev('tool_result', { tool_use_id: id, content, is_error });

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 560, padding: '0.6rem', background: '#0f172a' }}>
      <LightboxProvider>{children}</LightboxProvider>
    </div>
  );
}

export const SimpleConversation = () => (
  <Frame>
    <EventList
      events={[
        userText('what does this codebase do?'),
        asstText(
          "It's a local web monitor for Claude Code sessions — tails the JSONL transcripts and renders each session as a live panel.",
        ),
        userText('how do I run it?'),
        asstText('Run `npm run dev` in the repo root.'),
      ]}
    />
  </Frame>
);

export const WithToolCalls = () => (
  <Frame>
    <EventList
      events={[
        userText('count the .ts files'),
        toolUse('t1', 'Glob', { pattern: '**/*.ts' }),
        toolResult('t1', 'src/foo.ts\nsrc/bar.ts\nsrc/baz.ts'),
        asstText('There are 3 .ts files.'),
      ]}
    />
  </Frame>
);

export const InterruptedTurn = () => (
  <Frame>
    <EventList
      events={[
        userText('walk me through quicksort'),
        asstText('Sure — quicksort picks a pivot, partitions the array around it…'),
        userText('[Request interrupted by user]'),
        userText('nevermind, try mergesort'),
      ]}
    />
  </Frame>
);

export const OpStripCoalesced = () => (
  <Frame>
    <EventList
      events={[
        userText('survey the repo'),
        toolUse('t1', 'Glob', { pattern: '*.json' }),
        toolResult('t1', 'package.json'),
        toolUse('t2', 'Read', { file_path: 'package.json' }),
        toolResult('t2', '{"name":"brainhouse"}'),
        toolUse('t3', 'Grep', { pattern: 'TODO', path: 'src/' }),
        toolResult('t3', '7 matches'),
        toolUse('t4', 'Bash', { command: 'git status' }),
        toolResult('t4', 'On branch main'),
        asstText('Repo looks clean; 7 TODOs scattered through src/.'),
      ]}
    />
  </Frame>
);

export const FileChangeCoalesced = () => (
  <Frame>
    <EventList
      events={[
        userText('fix the bug in foo.ts'),
        toolUse('t1', 'Read', { file_path: '/tmp/foo.ts' }),
        toolResult('t1', 'export function foo() {}\n'),
        toolUse('t2', 'Edit', {
          file_path: '/tmp/foo.ts',
          old_string: 'foo()',
          new_string: 'foo(x: number)',
        }),
        toolResult('t2', 'edited'),
        toolUse('t3', 'Edit', {
          file_path: '/tmp/foo.ts',
          old_string: '{}',
          new_string: '{ return x * 2 }',
        }),
        toolResult('t3', 'edited'),
        asstText('Done — foo() now doubles its argument.'),
      ]}
    />
  </Frame>
);

export const AskUserQuestionBubble = () => (
  <Frame>
    <EventList
      events={[
        userText('which db should we use?'),
        toolUse('q1', 'AskUserQuestion', {
          questions: [
            {
              question: 'Which database?',
              header: 'DB',
              multiSelect: false,
              options: [
                { label: 'Postgres', description: 'OLTP workhorse' },
                { label: 'SQLite', description: 'local-first, zero ops' },
                { label: 'DuckDB', description: 'columnar / analytics' },
              ],
            },
          ],
        }),
      ]}
    />
  </Frame>
);

/**
 * Body-class effect: many bubble styles key off `body.imessage` or
 * `body.hide-thinking`. Ladle stories render in isolation, so we
 * temporarily toggle the class on mount + revert on unmount.
 */
function useBodyClass(cls: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [cls, enabled]);
}

const conversation: Event[] = [
  userText('hey, can you take a look at the slot allocator?'),
  ev('thinking', {
    text: 'They probably want me to find the file first. The allocator likely lives in src/lib — let me check there.',
  }),
  asstText("Sure — let me grep for it real quick."),
  toolUse('t1', 'Glob', { pattern: '**/slotAllocator*' }),
  toolResult('t1', 'client/src/lib/slotAllocator.ts'),
  ev('thinking', {
    text: 'Found it. I should also check the test file to understand the contract before diving in.',
  }),
  asstText("Found it at `client/src/lib/slotAllocator.ts`. The contract is: pinned panels first, then live, then round-robin by repo to fill remaining slots."),
  userText("does it handle the multi-account case?"),
  asstText("Not yet — that's planned. The TODO has a note about latest-wins per repo."),
];

/**
 * Default view: speech bubbles for the user/agent dialogue and a
 * thought bubble for each `thinking` event. Inverted puffy styling
 * for the thoughts; flat fill for speech.
 */
export const Conversation = () => (
  <Frame>
    <EventList events={conversation} />
  </Frame>
);

/**
 * Same conversation, iMessage mode. User bubbles right-aligned,
 * agent bubbles left-aligned, thought-bubble tail flips sides.
 */
export const ConversationIMessage = () => {
  useBodyClass('imessage', true);
  return (
    <Frame>
      <EventList events={conversation} />
    </Frame>
  );
};

/**
 * Same conversation rendered inside a `.has-theme` panel. The agent
 * bubbles and thought bubbles pick up the project's `.hued` theme
 * (foreground for thought-bubble fill, background for thought-bubble
 * text — inverted).
 */
export const ConversationThemed = () => (
  <div
    className="panel has-theme"
    style={{
      ['--panel-theme-bg' as string]: '#1f3a5f',
      ['--panel-theme-fg' as string]: '#9ec5ff',
      padding: '0.6rem',
      background: 'var(--bg)',
    }}
  >
    <Frame>
      <EventList events={conversation} />
    </Frame>
  </div>
);

/**
 * Hide-thinking pref engaged: agent thought bubbles disappear,
 * only speech remains.
 */
export const ConversationHideThinking = () => {
  useBodyClass('hide-thinking', true);
  return (
    <Frame>
      <EventList events={conversation} />
    </Frame>
  );
};

export const Mixed = () => (
  <Frame>
    <EventList
      events={[
        userText('add a test for the new feature'),
        asstText('Let me look at the existing tests first.'),
        toolUse('t1', 'Glob', { pattern: '**/*.test.ts' }),
        toolResult('t1', 'src/lib/foo.test.ts'),
        toolUse('t2', 'Read', { file_path: 'src/lib/foo.test.ts' }),
        toolResult('t2', '// existing test contents'),
        asstText("Got it. I'll add the new case to the existing file."),
        toolUse('t3', 'Edit', {
          file_path: 'src/lib/foo.test.ts',
          old_string: '// existing',
          new_string: '// existing\n// new test',
        }),
        toolResult('t3', 'edited'),
        asstText('Added. Run `npm test` to verify.'),
      ]}
    />
  </Frame>
);
