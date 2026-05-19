/**
 * Mock session synthesizers for poking at the UI without real Claude Code
 * transcripts. Each emit() pushes an Event through monitor.ingest() so the
 * exact same code path that handles live jsonl tailing applies.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TranscriptMonitor } from './monitor.js';
import type { Event } from './parser.js';

/** Hand the mock sessions a real directory so .hued theming has something to read. */
function pickMockCwd(): string {
  return path.join(os.homedir(), 'src', 'pensieve');
}

function emit(
  monitor: TranscriptMonitor,
  sessionId: string,
  agentId: string | null,
  uuid: string,
  kind: Event['kind'],
  payload: unknown,
  cwd: string | null = null,
): void {
  monitor.ingest({
    session_id: sessionId,
    agent_id: agentId,
    uuid,
    parent_uuid: null,
    ts: new Date().toISOString(),
    cwd,
    kind,
    payload: payload as Extract<Event, { kind: typeof kind }>['payload'],
  } as Event);
}

export async function simulateMockSession(monitor: TranscriptMonitor): Promise<string> {
  const sessionId = `mock-${randomUUID().slice(0, 8)}`;
  const cwd = pickMockCwd();
  void (async () => {
    emit(
      monitor,
      sessionId,
      null,
      `${sessionId}:u1`,
      'user_text',
      { text: 'summarize the top 3 numpy dtypes with a table and example code' },
      cwd,
    );
    await sleep(600);
    emit(monitor, sessionId, null, `${sessionId}:t1`, 'thinking', {
      text: 'outlining the dtypes and a code example',
    });
    await sleep(700);
    emit(monitor, sessionId, null, `${sessionId}:a1`, 'assistant_text', {
      text:
        '## Top 3 NumPy dtypes\n\n' +
        '| dtype | bytes | use case |\n|---|---|---|\n' +
        '| `int64` | 8 | general integer math |\n' +
        '| `float64` | 8 | scientific default |\n' +
        '| `bool_` | 1 | masks, predicates |\n\n' +
        '```python\nimport numpy as np\na = np.array([1, 2, 3], dtype=np.int64)\n```',
    });
    await sleep(800);
    emit(monitor, sessionId, null, `${sessionId}:tu1`, 'tool_use', {
      tool_use_id: 'tu1',
      name: 'Bash',
      input: { command: 'ls -la /tmp' },
    });
    await sleep(400);
    emit(monitor, sessionId, null, `${sessionId}:tr1`, 'tool_result', {
      tool_use_id: 'tu1',
      content: `total 16\n${Array.from({ length: 20 }, (_, i) => `drwxr-xr-x  3 mock ${i}`).join('\n')}`,
      is_error: false,
    });
    await sleep(500);
    emit(monitor, sessionId, null, `${sessionId}:a2`, 'assistant_text', {
      text: 'Done. Try `+ mock session` again for another.',
    });
  })();
  return sessionId;
}

export async function spawnSubagentIn(
  monitor: TranscriptMonitor,
  sessionId: string,
  stopAt = 20,
): Promise<string> {
  const agentId = `agent-mock-${randomUUID().slice(0, 6)}`;
  void (async () => {
    emit(monitor, sessionId, null, `${sessionId}:tu-${agentId}`, 'tool_use', {
      tool_use_id: `tu-${agentId}`,
      name: 'Task',
      input: { subagent_type: 'mock', description: `Stream ${stopAt} updates` },
    });
    emit(monitor, sessionId, agentId, `${sessionId}:${agentId}:meta`, 'meta', {
      record_type: 'subagent-meta',
      raw: { agentType: 'mock', description: `Stream ${stopAt} updates` },
    });
    const useChecklist = Math.random() < 0.5;
    if (useChecklist) {
      const items = Array.from({ length: stopAt }, (_, i) => `step ${i + 1}`);
      const block = (n: number) =>
        [
          'progress so far:',
          '',
          '```pensieve-checklist',
          ...items.map((label, i) => `- [${i < n ? 'x' : ' '}] ${label}`),
          '```',
        ].join('\n');
      for (let n = 0; n <= stopAt; n++) {
        emit(monitor, sessionId, agentId, `${sessionId}:${agentId}:cl${n}`, 'assistant_text', {
          text: block(n),
        });
        await sleep(600);
      }
    } else {
      for (let n = 1; n <= stopAt; n++) {
        emit(monitor, sessionId, agentId, `${sessionId}:${agentId}:s${n}`, 'assistant_text', {
          text: `step ${n}/${stopAt}: doing thing`,
        });
        await sleep(600);
      }
    }
    emit(monitor, sessionId, null, `${sessionId}:tr-${agentId}`, 'tool_result', {
      tool_use_id: `tu-${agentId}`,
      content: `completed ${stopAt} steps`,
      is_error: false,
    });
  })();
  return agentId;
}

export async function simulateCounterSubagent(
  monitor: TranscriptMonitor,
  stopAt = 100,
  intervalMs = 1000,
): Promise<{ sessionId: string; agentId: string }> {
  const sessionId = `mock-${randomUUID().slice(0, 8)}`;
  const agentId = `agent-counter-${randomUUID().slice(0, 6)}`;
  void (async () => {
    emit(monitor, sessionId, null, `${sessionId}:u1`, 'user_text', {
      text: `please count from 1 to ${stopAt}, one per second.`,
    });
    await sleep(300);
    emit(monitor, sessionId, null, `${sessionId}:a1`, 'assistant_text', {
      text: 'Delegating to a subagent to stream the count.',
    });
    emit(monitor, sessionId, null, `${sessionId}:tu1`, 'tool_use', {
      tool_use_id: `tu-${agentId}`,
      name: 'Task',
      input: { subagent_type: 'counter', description: `Count 1 to ${stopAt}` },
    });
    emit(monitor, sessionId, agentId, `${sessionId}:${agentId}:meta`, 'meta', {
      record_type: 'subagent-meta',
      raw: { agentType: 'counter', description: `Count 1 to ${stopAt}` },
    });
    emit(monitor, sessionId, agentId, `${sessionId}:${agentId}:u1`, 'user_text', {
      text: `Count from 1 to ${stopAt}, one per second.`,
    });
    for (let n = 1; n <= stopAt; n++) {
      emit(monitor, sessionId, agentId, `${sessionId}:${agentId}:${n}`, 'assistant_text', {
        text: String(n),
      });
      await sleep(intervalMs);
    }
    emit(monitor, sessionId, null, `${sessionId}:tr1`, 'tool_result', {
      tool_use_id: `tu-${agentId}`,
      content: `counted to ${stopAt}`,
      is_error: false,
    });
    emit(monitor, sessionId, null, `${sessionId}:a2`, 'assistant_text', {
      text: `All done — counted to **${stopAt}**.`,
    });
  })();
  return { sessionId, agentId };
}
