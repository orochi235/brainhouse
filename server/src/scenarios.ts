/**
 * Synthetic test scenarios — named, deterministic event sequences that
 * exercise specific UI/lifecycle paths. Used both for manual QA (UI button
 * spawns one) and for unit tests against SessionStore.
 *
 * Each scenario is a pure function that pushes Events through
 * `monitor.ingest()` (and occasionally `monitor.applyHookEvent()`). No
 * randomness — same params produce the same observable output. No external
 * Claude state; we synthesize everything.
 *
 * Adding a new scenario: define it, add to SCENARIOS at the bottom, give it
 * a `description` line that explains *what it should look like* if the
 * implementation is correct (so it doubles as a manual-test checklist).
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TranscriptMonitor } from './monitor.js';
import type { Event } from './parser.js';

export interface ScenarioMeta {
  key: string;
  name: string;
  description: string;
  /** What you should expect to see in the UI when this runs correctly. */
  expect: string;
}

export interface ScenarioRunOptions {
  /** Override the synthesized session_id so callers can reference it. */
  sessionId?: string;
  /** Override the cwd stamped on each event. Defaults to a synthetic
   * path so accidental real-project pollution can't happen. */
  cwd?: string;
}

interface Scenario extends ScenarioMeta {
  run: (monitor: TranscriptMonitor, opts: ScenarioRunOptions) => Promise<{ sessionId: string }>;
}

const SYNTHETIC_CWD = '/synthetic/brainhouse-scenarios';

function fresh(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function emit(
  monitor: TranscriptMonitor,
  sessionId: string,
  agentId: string | null,
  uuid: string,
  kind: Event['kind'],
  payload: unknown,
  cwd: string,
  tsOverride?: string,
): void {
  monitor.ingest({
    session_id: sessionId,
    agent_id: agentId,
    uuid,
    parent_uuid: null,
    ts: tsOverride ?? new Date().toISOString(),
    cwd,
    kind,
    payload: payload as Extract<Event, { kind: typeof kind }>['payload'],
    // biome-ignore lint/suspicious/noExplicitAny: payload narrowing varies per kind
  } as any);
}

// ---- Scenarios ----

const interrupt: Scenario = {
  key: 'interrupt',
  name: 'ctrl-c interrupted turn',
  description:
    'A user prompt, an assistant response that starts but is interrupted, then a follow-up prompt.',
  expect:
    'The assistant bubble should be dimmed with strikethrough. The two user bubbles merge into one with a sawtooth tear between them.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'explain quicksort' }, cwd);
    await sleep(300);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:a1`,
      'assistant_text',
      { text: 'Sure — quicksort picks a pivot, partitions, and recurses on each side…' },
      cwd,
    );
    await sleep(300);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:i1`,
      'user_text',
      { text: '[Request interrupted by user]' },
      cwd,
    );
    await sleep(100);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:u2`,
      'user_text',
      { text: 'actually nevermind, try mergesort instead' },
      cwd,
    );
    return { sessionId };
  },
};

const awaitingInput: Scenario = {
  key: 'awaiting-input',
  name: 'awaiting user input (Notification hook)',
  description: 'A session that triggered the Notification hook — waiting on permission or input.',
  expect:
    'Panel header should carry the "blocking on you" badge. Underlying status stays live.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:u1`,
      'user_text',
      { text: 'install the npm package and run the migration' },
      cwd,
    );
    await sleep(200);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:tu1`,
      'tool_use',
      { tool_use_id: `${sessionId}:t1`, name: 'Bash', input: { command: 'npm install foo' } },
      cwd,
    );
    await sleep(200);
    monitor.applyHookEvent({ session_id: sessionId, kind: 'notification', ts: Date.now() / 1000 });
    return { sessionId };
  },
};

const endedSubagent: Scenario = {
  key: 'ended-subagent',
  name: 'subagent ended (SubagentStop hook)',
  description:
    'A parent session spawns a subagent that completes. SubagentStop fires; the subagent should dim, parent stays live.',
  expect: 'Subagent panel dims (opacity per Display prefs slider). Parent panel unchanged.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'go research X for me' }, cwd);
    await sleep(150);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:tu1`,
      'tool_use',
      {
        tool_use_id: `tu-${agentId}`,
        name: 'Task',
        input: { subagent_type: 'general-purpose', description: 'Research X' },
      },
      cwd,
    );
    emit(
      monitor,
      sessionId,
      agentId,
      `${sessionId}:${agentId}:meta`,
      'meta',
      { record_type: 'subagent-meta', raw: { agentType: 'general-purpose', description: 'Research X' } },
      cwd,
    );
    for (let i = 0; i < 4; i++) {
      emit(
        monitor,
        sessionId,
        agentId,
        `${sessionId}:${agentId}:a${i}`,
        'assistant_text',
        { text: `step ${i + 1}/4` },
        cwd,
      );
      await sleep(100);
    }
    monitor.applyHookEvent({ session_id: sessionId, kind: 'subagent_stop', ts: Date.now() / 1000 });
    return { sessionId };
  },
};

const parentStopNoDim: Scenario = {
  key: 'parent-stop-no-dim',
  name: 'parent Stop (no dim, summary materialized)',
  description:
    'A parent session that finished its turn via the Stop hook. Should write a session_summary with hook_stop provenance but NOT visually dim — the user might prompt again.',
  expect:
    'Panel transitions to done but does NOT carry the .ended class. `SELECT ended_provenance FROM session_summary` shows `hook_stop`.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'hello!' }, cwd);
    await sleep(150);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:a1`,
      'assistant_text',
      { text: 'Hi! What can I help with?' },
      cwd,
    );
    await sleep(150);
    monitor.applyHookEvent({ session_id: sessionId, kind: 'stop', ts: Date.now() / 1000 });
    return { sessionId };
  },
};

const fanOut: Scenario = {
  key: 'fan-out',
  name: 'one parent → 3 subagents',
  description:
    'A parent that spawns three subagents in parallel. Two end (SubagentStop); one stays live. Exercises the nested-subagent rendering + multi-subagent dock routing.',
  expect:
    'Parent panel hosts a nested tray with 3 subagents. Two are dimmed; one is live and orange-pulsing.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'do three things at once' }, cwd);
    const agents = ['research', 'audit', 'plan'].map((t) => ({
      id: `agent-${randomUUID().slice(0, 8)}`,
      type: t,
    }));
    for (const a of agents) {
      emit(
        monitor,
        sessionId,
        null,
        `${sessionId}:tu-${a.id}`,
        'tool_use',
        {
          tool_use_id: `tu-${a.id}`,
          name: 'Task',
          input: { subagent_type: 'general-purpose', description: `${a.type} task` },
        },
        cwd,
      );
      emit(
        monitor,
        sessionId,
        a.id,
        `${sessionId}:${a.id}:meta`,
        'meta',
        { record_type: 'subagent-meta', raw: { agentType: 'general-purpose', description: `${a.type} task` } },
        cwd,
      );
      emit(
        monitor,
        sessionId,
        a.id,
        `${sessionId}:${a.id}:a1`,
        'assistant_text',
        { text: `working on ${a.type}…` },
        cwd,
      );
      await sleep(80);
    }
    await sleep(200);
    // First two end; third keeps going.
    for (const a of agents.slice(0, 2)) {
      const deltas = monitor.store.markEnded(a.id, 'hook_subagent_stop');
      for (const d of deltas) monitor.emitter.emit('delta', d);
    }
    return { sessionId };
  },
};

const idleCascade: Scenario = {
  key: 'idle-cascade',
  name: 'panel that aged out before brainhouse saw it',
  description:
    'A panel synthesized with an old timestamp so the next tick demotes it through live → done → mini in one go. Tests the bootstrap-replay timestamp accuracy + auto-mini routing.',
  expect:
    'Panel appears in the dock immediately (auto-routed because >30s stale). Status reads "done Xm ago" with a real elapsed time, not "0s ago".',
  async run(monitor, { sessionId = fresh('stale'), cwd = SYNTHETIC_CWD } = {}) {
    const oldTs = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90 min ago
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'old prompt' }, cwd, oldTs);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:a1`,
      'assistant_text',
      { text: 'old reply that you forgot about' },
      cwd,
      oldTs,
    );
    // Nudge a tick so lifecycle catches up.
    for (const d of monitor.store.tick()) monitor.emitter.emit('delta', d);
    return { sessionId };
  },
};

const longResult: Scenario = {
  key: 'long-result',
  name: 'flurry of tool calls between chats (op-strip)',
  description:
    'A run of Read/Edit/Write calls on the same file between two assistant bubbles. Pipeline should coalesce into a file-change row, then a wider op-strip if there are other unrelated tools too.',
  expect: 'Single file-change row replaces ~5 individual tool capsules. Click opens the diff lightbox.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'fix the bug in foo.ts' }, cwd);
    const file = '/tmp/foo.ts';
    const ops: Array<[string, Record<string, unknown>, string]> = [
      ['Read', { file_path: file }, 'export function foo() {}\n'],
      ['Edit', { file_path: file, old_string: 'foo()', new_string: 'foo(x: number)' }, 'edited'],
      ['Edit', { file_path: file, old_string: '{}', new_string: '{ return x * 2; }' }, 'edited'],
      ['Read', { file_path: file }, 'export function foo(x: number) { return x * 2; }\n'],
    ];
    for (let i = 0; i < ops.length; i++) {
      const [name, input, result] = ops[i] as [string, Record<string, unknown>, string];
      const tid = `${sessionId}:t${i}`;
      emit(
        monitor,
        sessionId,
        null,
        `${sessionId}:tu${i}`,
        'tool_use',
        { tool_use_id: tid, name, input },
        cwd,
      );
      await sleep(40);
      emit(
        monitor,
        sessionId,
        null,
        `${sessionId}:tr${i}`,
        'tool_result',
        { tool_use_id: tid, content: result, is_error: false },
        cwd,
      );
      await sleep(40);
    }
    emit(monitor, sessionId, null, `${sessionId}:a1`, 'assistant_text', { text: 'done — foo() now doubles its argument.' }, cwd);
    return { sessionId };
  },
};

const askUserQuestion: Scenario = {
  key: 'ask-user-question',
  name: 'AskUserQuestion tool',
  description:
    "An AskUserQuestion tool call. Pipeline should render this as if Claude is speaking — bolded question with bulleted options — and swallow the matching tool_result.",
  expect:
    'No tool capsule. Single assistant bubble showing the question + options as markdown.',
  async run(monitor, { sessionId = fresh('mock'), cwd = SYNTHETIC_CWD } = {}) {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'which backend should we use?' }, cwd);
    await sleep(150);
    const tid = `${sessionId}:t1`;
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:tu1`,
      'tool_use',
      {
        tool_use_id: tid,
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which database?',
              header: 'DB',
              multiSelect: false,
              options: [
                { label: 'Postgres', description: 'OLTP workhorse; great durability story' },
                { label: 'SQLite', description: 'Local-first; zero ops; one file' },
                { label: 'DuckDB', description: 'Analytics-friendly columnar storage' },
              ],
            },
          ],
        },
      },
      cwd,
    );
    await sleep(50);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:tr1`,
      'tool_result',
      { tool_use_id: tid, content: 'pending user response', is_error: false },
      cwd,
    );
    return { sessionId };
  },
};

const themedPanel: Scenario = {
  key: 'themed-panel',
  name: 'panel with a hued theme',
  description:
    'A panel stamped with a synthetic .hued color (since we never touch your real ~/src/* paths). Exercises the themed waiting halo + themed thinking indicator.',
  expect:
    'Panel border tinted. Assistant bubble dominated by the theme color. Halo pulses in the same hue when waiting.',
  async run(monitor, { sessionId = fresh('themed'), cwd = SYNTHETIC_CWD } = {}) {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'paint me a picture' }, cwd);
    await sleep(100);
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:a1`,
      'assistant_text',
      { text: 'Sure — let me sketch this out.' },
      cwd,
    );
    // Force-set a theme so we don't need a real .hued on disk.
    const deltas = monitor.store.setTheme(sessionId, {
      background: '#0e7c66',
      foreground: '#ffffff',
    });
    for (const d of deltas) monitor.emitter.emit('delta', d);
    // Leave it pending — the next tick will keep it live; the halo should pulse.
    return { sessionId };
  },
};

const checklistProgressive: Scenario = {
  key: 'checklist-progressive',
  name: 'checklist that fills in over time',
  description:
    'A pinned pensieve-checklist block, refreshed over multiple assistant messages with more items checked each time. Exercises the checklist pin + progress bar.',
  expect:
    'Pinned checklist appears above the panel body. Items tick off one by one as messages stream in.',
  async run(monitor, { sessionId = fresh('checklist'), cwd = SYNTHETIC_CWD } = {}) {
    const items = ['fetch data', 'parse json', 'validate schema', 'write output'];
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', { text: 'do those four things' }, cwd);
    for (let n = 0; n <= items.length; n++) {
      const block = [
        'progress so far:',
        '',
        '```pensieve-checklist',
        ...items.map((label, i) => `- [${i < n ? 'x' : ' '}] ${label}`),
        '```',
      ].join('\n');
      emit(
        monitor,
        sessionId,
        null,
        `${sessionId}:cl${n}`,
        'assistant_text',
        { text: block },
        cwd,
      );
      await sleep(300);
    }
    return { sessionId };
  },
};

export const SCENARIOS: Scenario[] = [
  interrupt,
  awaitingInput,
  endedSubagent,
  parentStopNoDim,
  fanOut,
  idleCascade,
  longResult,
  askUserQuestion,
  themedPanel,
  checklistProgressive,
];

export function getScenario(key: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.key === key);
}

export function listScenarios(): ScenarioMeta[] {
  return SCENARIOS.map(({ key, name, description, expect }) => ({ key, name, description, expect }));
}
