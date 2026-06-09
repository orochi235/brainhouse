/**
 * Stand-in selector data for Spec 2. The real engine lands in Spec 1; cutover
 * is a one-line change in `./index.ts`. Entries below are picked to exercise
 * inspector UI corners — long descriptions, missing sample payload, multi-
 * transform "used by" cross-links, single-transform, none-declared.
 */

import type { Event } from '@server/parser.ts';
import type { Selector, SelectorDef } from './types.ts';

export const MOCK_SELECTORS: SelectorDef[] = [
  {
    key: 'tool-use.todowrite',
    name: 'TodoWrite tool_use',
    description: 'A tool_use event whose tool name is exactly "TodoWrite".',
    selector: 'event[kind=tool_use] > tool_use[name=TodoWrite]',
    samplePayload: {
      kind: 'tool_use',
      payload: {
        tool_use_id: 'toolu_01ABC',
        name: 'TodoWrite',
        input: { todos: [{ content: 'demo', status: 'pending' }] },
      },
    },
  },
  {
    key: 'tool-use.bash',
    name: 'Bash tool_use',
    description: 'A tool_use event whose tool name is "Bash".',
    selector: 'event[kind=tool_use] > tool_use[name=Bash]',
    samplePayload: {
      kind: 'tool_use',
      payload: { tool_use_id: 'toolu_02DEF', name: 'Bash', input: { command: 'ls' } },
    },
  },
  {
    key: 'tool-use.askuserquestion',
    name: 'AskUserQuestion tool_use',
    description: 'A tool_use event for the AskUserQuestion built-in tool.',
    selector: 'event[kind=tool_use] > tool_use[name=AskUserQuestion]',
    samplePayload: {
      kind: 'tool_use',
      payload: {
        tool_use_id: 'toolu_03GHI',
        name: 'AskUserQuestion',
        input: { question: 'go?' },
      },
    },
  },
  {
    key: 'user-text.bash',
    name: 'Bash-tagged user_text',
    description:
      'A user_text event whose body contains a <bash-input> tag — i.e. the user invoked a slash-prefixed bash command.',
    selector: 'event[kind=user_text] > text[contains=<bash-input]',
    samplePayload: {
      kind: 'user_text',
      payload: { text: '<bash-input>ls -la</bash-input>' },
    },
  },
  {
    key: 'assistant-text.bh-title',
    name: 'Assistant <bh-title> marker',
    description:
      'An assistant_text event with a trailing <bh-title>…</bh-title> marker that the title transform strips.',
    // NOTE: deliberately no samplePayload to exercise the "(no sample)" UI.
    selector: 'event[kind=assistant_text] > text[contains=<bh-title]',
  },
  {
    key: 'meta.queue-operation',
    name: 'Queue-operation meta',
    description: 'Sidechannel meta event recording a queued /btw operation.',
    selector: 'event[kind=meta] > meta[kind=queue-operation]',
    samplePayload: {
      kind: 'meta',
      payload: { block_type: 'queue-operation', raw: { op: 'add', text: '/btw …' } },
    },
  },
];

/** Stub matcher — always returns false until Spec 1's engine lands. */
export const mockMatcher = (_e: Event) => false;

/**
 * Stub `resolveSelector(key)` — returns a `Selector` whose `match` is the
 * never-matching stub. Spec 1 replaces this barrel; the inspector code path
 * stays unchanged.
 */
export function resolveSelector(_key: string): Selector {
  return { source: '', ast: {} as unknown, match: mockMatcher };
}

/** Compile a raw selector source — stub: never matches, never throws. */
export function compileSelector(source: string): Selector {
  return { source, ast: {} as unknown, match: mockMatcher };
}
