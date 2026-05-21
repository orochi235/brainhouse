/**
 * Mock session synthesizers for poking at the UI without real Claude Code
 * transcripts. Each emit() pushes an Event through monitor.ingest() so the
 * exact same code path that handles live jsonl tailing applies.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TranscriptMonitor } from './monitor.js';
import type { Event } from './parser.js';

/** Hand the mock sessions a real directory so .hued theming has something to
 * read. Walks up from process.cwd() to the first ancestor that has a .hued,
 * so spawning a mock from inside `brainhouse/server/` finds `brainhouse/.hued`. */
function pickMockCwd(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, '.hued'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
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

/**
 * Mock session = a tiny scripted conversation. Each scenario is an array of
 * steps that the runner plays back with a delay between them, generating
 * uuids and pairing tool_use with tool_result automatically.
 */
interface UserStep {
  kind: 'user';
  text: string;
  delay?: number;
}
interface AsstStep {
  kind: 'asst';
  text: string;
  delay?: number;
}
interface ThinkStep {
  kind: 'think';
  text: string;
  delay?: number;
}
interface ToolStep {
  kind: 'tool';
  name: string;
  input: unknown;
  result: string;
  is_error?: boolean;
  delay?: number;
}
type Step = UserStep | AsstStep | ThinkStep | ToolStep;

const SCENARIOS: { title: string; steps: Step[] }[] = [
  {
    title: 'cat morse',
    steps: [
      { kind: 'user', text: "convert my cat's meows to morse code" },
      { kind: 'think', text: 'mapping vowel-leaning meows to dots, consonants to dashes' },
      {
        kind: 'asst',
        text: '`meow` → `-- . --- .--` ("M E O W"). Long meows lean dash; short chirps lean dot. A purr is interpreted as continuous transmission carrier.',
      },
    ],
  },
  {
    title: 'rubber duck capacity',
    steps: [
      { kind: 'user', text: "what's the maximum number of rubber ducks that fit in a Subaru?" },
      {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'python3 -c "print(3531 * 0.74)"' },
        result: '2612.94',
      },
      {
        kind: 'asst',
        text: 'Cargo volume ≈ 100 cu ft; one duck ≈ 28 cu in; with 74% packing efficiency you fit **~2,612 ducks** before they start squeaking in protest.',
      },
    ],
  },
  {
    title: 'bee movie haiku',
    steps: [
      { kind: 'user', text: 'rewrite the bee movie script in haiku form' },
      { kind: 'think', text: 'compressing 90 minutes of bee monologue into 5-7-5' },
      {
        kind: 'asst',
        text: 'You like jazz, huh?\nSmall bee, big legal questions —\nHoney lawsuit blooms.',
      },
    ],
  },
  {
    title: 'judgy fridge',
    steps: [
      { kind: 'user', text: 'design a UI for a fridge that judges you' },
      {
        kind: 'tool',
        name: 'Write',
        input: { file_path: '/tmp/fridge.tsx' },
        result: 'wrote 42 lines',
      },
      {
        kind: 'asst',
        text: 'Built `<JudgyFridge />`: a top banner that reads "Again? Really?" whenever the door opens after 11pm. The leftover lasagna gets its own passive-aggressive countdown.',
      },
    ],
  },
  {
    title: 'hot dog proof',
    steps: [
      { kind: 'user', text: 'is a hot dog a sandwich? give a formal proof' },
      {
        kind: 'asst',
        text: '**Theorem.** A hot dog is *not* a sandwich.\n\n**Proof.** Let S = {(bread, filling) : bread fully encloses filling on ≥3 sides}. A hot dog bun encloses on 2 sides (hinged base). Therefore (bun, frank) ∉ S. ∎',
      },
    ],
  },
  {
    title: 'stop sign mirrors',
    steps: [
      { kind: 'user', text: 'what would happen if we replaced all stop signs with mirrors?' },
      { kind: 'think', text: 'drivers see themselves; either confusion or introspection' },
      {
        kind: 'asst',
        text: "Drivers stop briefly to assess their hair. Net traffic flow drops 8% but national self-image improves modestly. Intersection accidents rise sharply at sunrise and sunset due to glare. Don't do this.",
      },
    ],
  },
  {
    title: 'regex for dread',
    steps: [
      { kind: 'user', text: 'write a regex that matches existential dread' },
      {
        kind: 'tool',
        name: 'Grep',
        input: { pattern: '\\b(why|point|anyway|whatever)\\b', path: 'inner-monologue.txt' },
        result:
          'inner-monologue.txt:14: why am I doing this anyway\ninner-monologue.txt:27: whatever, fine',
      },
      {
        kind: 'asst',
        text: '`/(?:\\b(?:why|anyway|whatever)\\b.*){2,}/i` — matches when at least two existential-tells co-occur. False positives on group chats are expected.',
      },
    ],
  },
  {
    title: 'pirate quicksort',
    steps: [
      { kind: 'user', text: 'implement quicksort in pirate-speak' },
      {
        kind: 'tool',
        name: 'Write',
        input: { file_path: '/tmp/quicksort.swab' },
        result: "wrote 18 lines of seafarin' code",
      },
      {
        kind: 'asst',
        text: "```\nfunction sortYeBooty(crew):\n  if len(crew) <= 1: yarrr return crew\n  pivot = crew.first  // the cap'n\n  scallywags = [x for x in crew[1:] if x < pivot]\n  swabbies   = [x for x in crew[1:] if x >= pivot]\n  return sortYeBooty(scallywags) + [pivot] + sortYeBooty(swabbies)\n```",
      },
    ],
  },
  {
    title: 'monads as utensils',
    steps: [
      { kind: 'user', text: 'explain monads using only kitchen utensils' },
      {
        kind: 'asst',
        text: "A **whisk** is a functor: it lifts whatever's in the bowl. A **measuring cup** is `pure`: it boxes one ingredient. **Pouring one cup into the next** is `bind`. The **Maybe monad** is the spoon you may or may not have washed. ∎",
      },
    ],
  },
  {
    title: 'mild disappointment unicode',
    steps: [
      { kind: 'user', text: "what's the unicode for 'mild disappointment'?" },
      {
        kind: 'tool',
        name: 'WebFetch',
        input: { url: 'https://unicode.org/charts/' },
        result: 'fetched 12 KB',
      },
      {
        kind: 'asst',
        text: "There's no official codepoint, but U+1F614 (😔 PENSIVE FACE) is widely accepted. For more granularity I'd propose U+1F614 followed by U+200D U+1F4A8 (zero-width-joiner + dash of air).",
      },
    ],
  },
  {
    title: 'angry goose letter',
    steps: [
      { kind: 'user', text: 'draft a strongly-worded letter from a goose' },
      {
        kind: 'asst',
        text: 'To Whom It May Concern,\n\nHONK. **HONK**. The pond is mine. The path is mine. The picnic is *implicitly* mine. Your continued presence is noted and resented.\n\nWarmest hisses,\n*A Goose*',
      },
    ],
  },
  {
    title: 'leg day CSS',
    steps: [
      { kind: 'user', text: 'build a CSS selector that targets people who skip leg day' },
      {
        kind: 'tool',
        name: 'Edit',
        input: { file_path: '/tmp/gym.css' },
        result: '+8 -0',
      },
      {
        kind: 'asst',
        text: '```css\nbody[data-routine~="upper"]:not([data-routine~="lower"]) .silhouette {\n  --proportions: chicken-legged;\n  transform: scaleY(1.05) scaleX(0.92) translateY(8px);\n}\n```',
      },
    ],
  },
  {
    title: 'undefined latin',
    steps: [
      { kind: 'user', text: 'translate `error: undefined` into Latin' },
      {
        kind: 'asst',
        text: '**`Errorem: Nullum Constitutum`** — lit. "an error: nothing established." For the more existential vibe, *Quid hoc est?* ("what even is this?") is widely understood among latinate sysadmins.',
      },
    ],
  },
  {
    title: 'yelling at clouds',
    steps: [
      { kind: 'user', text: 'calculate the calories burned by yelling at clouds' },
      {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'python3 -c "print(round(3.5 * 70 * (15/60), 1))"' },
        result: '61.3',
      },
      {
        kind: 'asst',
        text: 'For a 70 kg human yelling vigorously for 15 minutes: about **61 kcal**. Roughly one bite of sandwich. Negligible. Pace yourself.',
      },
    ],
  },
  {
    title: 'trader joes parking',
    steps: [
      {
        kind: 'user',
        text: "what's the time complexity of finding a parking spot at trader joe's",
      },
      { kind: 'think', text: 'modeling worst case vs amortized over a Saturday afternoon' },
      {
        kind: 'asst',
        text: '**Worst case: `O(∞)`** if a Subaru is double-parked near the entrance. **Amortized: `O(n²)`** in number of shoppers, due to circling behavior. Best case `O(1)` only at 9:02 a.m. on a Tuesday.',
      },
    ],
  },
  {
    title: 'junk drawer schema',
    steps: [
      { kind: 'user', text: 'design a database schema for the contents of a junk drawer' },
      {
        kind: 'tool',
        name: 'Write',
        input: { file_path: '/tmp/junk_drawer.sql' },
        result: 'wrote 26 lines',
      },
      {
        kind: 'asst',
        text: "```sql\nCREATE TABLE artifact (\n  id           SERIAL PRIMARY KEY,\n  category     TEXT,        -- batteries|cables|takeout_menus|??\n  identifiable BOOLEAN,     -- whether you remember why you kept it\n  half_life_d  INT,         -- days until you can toss without guilt\n  vibe         TEXT CHECK (vibe IN ('sentimental','practical','mystery'))\n);\n```",
      },
    ],
  },
  {
    title: 'polite ransom fonts',
    steps: [
      { kind: 'user', text: 'name 5 fonts that would make a ransom note look polite' },
      {
        kind: 'asst',
        text: "1. **Comic Sans MS** — disarming, almost apologetic.\n2. **Garamond** — bookish, hint of regret.\n3. **Hoefler Text** — wedding-invitation energy.\n4. **Marker Felt** — kindergarten field-trip vibe.\n5. **Papyrus** — they're trying their best.",
      },
    ],
  },
  {
    title: 'regrets SQL',
    steps: [
      { kind: 'user', text: 'write a SQL query against my regrets table' },
      {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'psql -d life -c "\\d regrets"' },
        result:
          'Table "public.regrets"\n  decision  text\n  severity  numeric  -- 1..10\n  reviewed  boolean\n',
      },
      {
        kind: 'asst',
        text: "```sql\nSELECT decision\nFROM regrets\nWHERE severity >= 7\n  AND NOT reviewed\nORDER BY severity DESC\nLIMIT 3;\n```\nLimit 3 because that's all the therapy budget allows this month.",
      },
    ],
  },
  {
    title: 'vibes gradient',
    steps: [
      { kind: 'user', text: "what's the gradient of vibes with respect to monday morning" },
      { kind: 'think', text: 'partial derivatives in mood-space' },
      {
        kind: 'asst',
        text: '`∂(vibes)/∂(monday morning) ≈ -0.72` (steeply negative). The second derivative is positive — vibes accelerate back up by 10am with coffee. Closed-form solution requires a 3-day weekend.',
      },
    ],
  },
  {
    title: 'awkward silence fathoms',
    steps: [
      { kind: 'user', text: 'convert a kilometer of awkward silence to fathoms' },
      {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'python3 -c "print(1000 / 1.8288)"' },
        result: '546.81',
      },
      {
        kind: 'asst',
        text: '**~546.8 fathoms** of awkward silence. Note: fathoms are properly used for water depth, which feels apt — awkward silences have a similar drowning quality.',
      },
    ],
  },
];

async function runScenario(
  monitor: TranscriptMonitor,
  sessionId: string,
  cwd: string,
  scenario: { title: string; steps: Step[] },
): Promise<void> {
  let n = 0;
  for (const step of scenario.steps) {
    const uid = `${sessionId}:s${n++}`;
    if (step.kind === 'user') {
      emit(monitor, sessionId, null, uid, 'user_text', { text: step.text }, cwd);
    } else if (step.kind === 'asst') {
      emit(monitor, sessionId, null, uid, 'assistant_text', { text: step.text });
    } else if (step.kind === 'think') {
      emit(monitor, sessionId, null, uid, 'thinking', { text: step.text });
    } else {
      const tuid = `tu-${uid}`;
      emit(monitor, sessionId, null, uid, 'tool_use', {
        tool_use_id: tuid,
        name: step.name,
        input: step.input,
      });
      await sleep(step.delay ?? 400);
      emit(monitor, sessionId, null, `${uid}:r`, 'tool_result', {
        tool_use_id: tuid,
        content: step.result,
        is_error: step.is_error ?? false,
      });
    }
    await sleep(step.delay ?? 600);
  }
}

export async function simulateMockSession(monitor: TranscriptMonitor): Promise<string> {
  const sessionId = `mock-${randomUUID().slice(0, 8)}`;
  const cwd = pickMockCwd();
  const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  if (!scenario) throw new Error('no mock scenarios available');
  void runScenario(monitor, sessionId, cwd, scenario);
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
    const useChecklist = Math.random() < 0.9;
    if (useChecklist) {
      const items = Array.from({ length: stopAt }, (_, i) => `step ${i + 1}`);
      const block = (n: number) =>
        [
          'progress so far:',
          '',
          '```brainhouse-checklist',
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
