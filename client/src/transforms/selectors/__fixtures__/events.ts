/**
 * Shared Event fixtures for selector compile/registry tests. Built with the
 * same loose shape as `client/src/lib/pipeline.test.ts` — `tags` is optional
 * on synthetic fixtures (the parser-produced events always carry one), and
 * we lean on a cast to `Event`.
 */

import type { Event } from '@server/parser.ts';

function base(uuid: string, tags?: Event['tags']): Omit<Event, 'kind' | 'payload'> {
  return {
    session_id: 's1',
    agent_id: null,
    uuid,
    parent_uuid: null,
    ts: '2026-06-08T00:00:00Z',
    cwd: null,
    tags: tags ?? [],
  };
}

export const F = {
  userText: { ...base('u1', ['dialogue']), kind: 'user_text', payload: { text: 'hello' } } as Event,
  userTextNoTags: ({
    session_id: 's1',
    agent_id: null,
    uuid: 'u1b',
    parent_uuid: null,
    ts: '2026-06-08T00:00:00Z',
    cwd: null,
    kind: 'user_text',
    payload: { text: 'hello' },
  } as unknown as Event),
  userMeta: {
    ...base('u2', ['meta']),
    kind: 'user_text',
    payload: { text: 'skill prelude', is_meta: true, source_tool_use_id: 't1' },
  } as Event,
  userArtifact: {
    ...base('u3', ['artifact']),
    kind: 'user_text',
    payload: { text: '<local-command-stdout>x</local-command-stdout>' },
  } as Event,
  userBash: {
    ...base('u4', ['dialogue']),
    kind: 'user_text',
    payload: { text: '<bash-input>ls</bash-input><bash-stdout>foo</bash-stdout>' },
  } as Event,
  asstPlain: {
    ...base('a1', ['dialogue']),
    kind: 'assistant_text',
    payload: { text: 'hi back' },
  } as Event,
  asstWithBhTitle: {
    ...base('a2', ['dialogue']),
    kind: 'assistant_text',
    payload: { text: 'done\n<!-- bh-title: Working on the foo -->' },
  } as Event,
  toolUseBash: {
    ...base('tu1', ['tool']),
    kind: 'tool_use',
    payload: { tool_use_id: 't1', name: 'Bash', input: { command: 'ls' } },
  } as Event,
  toolUseTask: {
    ...base('tu2', ['tool']),
    kind: 'tool_use',
    payload: { tool_use_id: 't2', name: 'Task', input: { description: 'do thing' } },
  } as Event,
  toolUseTodoWrite: {
    ...base('tu3', ['tool']),
    kind: 'tool_use',
    payload: { tool_use_id: 't3', name: 'TodoWrite', input: { todos: [] } },
  } as Event,
  toolUseTaskCreate: {
    ...base('tu3b', ['tool']),
    kind: 'tool_use',
    payload: { tool_use_id: 't3b', name: 'TaskCreate', input: { subject: 'a task' } },
  } as Event,
  toolUseTaskUpdate: {
    ...base('tu3c', ['tool']),
    kind: 'tool_use',
    payload: { tool_use_id: 't3c', name: 'TaskUpdate', input: { taskId: '1' } },
  } as Event,
  toolUseAskUserQuestion: {
    ...base('tu4', ['tool']),
    kind: 'tool_use',
    payload: { tool_use_id: 't4', name: 'AskUserQuestion', input: { questions: [] } },
  } as Event,
  toolResult: {
    ...base('tr1', ['tool']),
    kind: 'tool_result',
    payload: { tool_use_id: 't1', content: 'ok', is_error: false },
  } as Event,
  metaEvent: {
    ...base('m1', ['meta']),
    kind: 'meta',
    payload: { record_type: 'custom-title', raw: { title: 'x' } },
  } as Event,
  thinkingEvent: {
    ...base('th1', ['thinking']),
    kind: 'thinking',
    payload: { text: 'pondering' },
  } as Event,
  systemEvent: {
    ...base('sys1', ['system']),
    kind: 'system',
    payload: { subtype: null, content: 'system message', level: null },
  } as Event,
};
