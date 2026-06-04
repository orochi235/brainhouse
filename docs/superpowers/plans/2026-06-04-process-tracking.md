# Process tracking dashboard — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live process tracker that fuses Claude Code hook signals with `ps`/`lsof` host observation, surfaced as a dedicated dashboard component listing every dev-server-like process across all sessions, with kill/open-URL/jump-to-session/tail actions.

**Architecture:** Three hooks (SessionStart, PreToolUse, PostToolUse) emit side-channel JSONL records into `~/.brainhouse/events/<sessionId>.jsonl`. A new `ProcessTracker` module in `server/src/processes/` consumes those records, polls `ps` (1Hz) and `lsof` (5Hz, subscriber-gated), maintains an in-memory `processes` table with tiered provenance (`hooked` / `observed` / `heuristic` / `discovered`), and broadcasts changes over the existing tRPC delta stream. The client renders a `ProcessesPanel` React component in the main grid as a sibling to `ProjectWidgetCard`.

**Tech Stack:** TypeScript, Node 20+, vitest, tRPC, React, npm workspaces. Native shellouts via `node:child_process` (`execFile` + `promisify`). No new runtime deps.

**Scope note:** kqueue `NOTE_EXIT` (spec section "Capture pipeline #6") is deferred — Node has no first-class binding. The 1Hz tree-walker's two-tick absence rule is the v1 death signal. A follow-up plan can add `ffi-napi` + kqueue once the rest is working.

**Component-level mapping ProcessesPanel placement:** The spec says "peer of `ProjectWidgetCard`". The implementer must read `client/src/App.tsx` to find where `ProjectWidgetCard` is rendered in the grid and insert `<ProcessesPanel />` adjacent to it. Treat this as a discovery step inside Task 14 — don't guess the exact element.

---

## File structure

**New files:**

```
hooks/
  session-start-procs.mjs       # writes session_pid record
  pre-tool-use-bash.mjs         # writes bash_intent record
  post-tool-use-bash.mjs        # writes bash_id_map record (run_in_background only)

server/src/processes/
  index.ts                      # public ProcessTracker class + types
  native.ts                     # ps, lsof, kill shellouts (host-specific isolation point)
  runtime.ts                    # runtime + version detection (path → probe → argv)
  framework.ts                  # framework + version detection from argv + package.json
  reconciler.ts                 # the table; tree walker; intent matcher; death rule
  ports.ts                      # subscriber-gated lsof sweeper
  discovery.ts                  # startup lsof sweep for already-listening services
  index.test.ts
  native.test.ts
  runtime.test.ts
  framework.test.ts
  reconciler.test.ts
  ports.test.ts

client/src/components/
  ProcessesPanel.tsx            # dashboard component
  ProcessRow.tsx                # one table row
  ProcessesPanel.test.tsx
  ProcessRow.test.tsx
```

**Modified files:**

```
server/src/hookEvents.ts        # extend HookEventSchema with new kinds
server/src/session.ts           # extend Delta union with process_upsert/delete/ports
server/src/index.ts             # construct + wire ProcessTracker
server/src/trpc.ts              # add processes.* router (subscribe, kill, tailStdout)
client/src/useDeltaStream.ts    # reducer cases for process_* deltas
client/src/App.tsx              # render <ProcessesPanel /> in the grid
bin/init.js                     # register the three new hooks in hookRegistry()
```

---

## Task 1: SessionStart hook — emit session_pid record

**Files:**
- Create: `hooks/session-start-procs.mjs`
- Create: `hooks/session-start-procs.test.mjs`

The hook reads Claude Code's stdin payload (`{session_id, transcript_path, source, ...}`), captures its own `process.ppid` (the parent — Claude Code's session process), and appends a `session_pid` record to `~/.brainhouse/events/<sessionId>.jsonl`. It writes nothing to stdout (no `additionalContext`).

We need the **parent's** PID, not our own, because the hook runs as a child of the Claude session process. `process.ppid` gives us the session.

- [ ] **Step 1: Write the failing test**

`hooks/session-start-procs.test.mjs`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('./session-start-procs.mjs', import.meta.url).pathname;

describe('session-start-procs hook', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bh-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('writes a session_pid record with our ppid', () => {
    const payload = JSON.stringify({ session_id: 'sess-1', source: 'startup' });
    const res = spawnSync(process.execPath, [HOOK], {
      input: payload,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
    const path = join(home, '.brainhouse', 'events', 'sess-1.jsonl');
    expect(existsSync(path)).toBe(true);
    const rec = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(rec.kind).toBe('session_pid');
    expect(rec.session_id).toBe('sess-1');
    expect(typeof rec.pid).toBe('number');
    expect(rec.pid).toBe(process.pid); // we are the parent of the spawned node
    expect(typeof rec.ts).toBe('number');
    expect(typeof rec.start_ts).toBe('number');
    expect(typeof rec.cwd).toBe('string');
  });

  it('exits 0 with no record when session_id is missing', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({}),
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(existsSync(join(home, '.brainhouse'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
cd /Users/mike/src/brainhouse && npx vitest run hooks/session-start-procs.test.mjs
```

Expected: FAIL — `Cannot find module session-start-procs.mjs`.

- [ ] **Step 3: Implement the hook**

`hooks/session-start-procs.mjs`:

```javascript
#!/usr/bin/env node
import { mkdirSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function readStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function startTsNs(pid) {
  // Best-effort: ps lstart is human-formatted; ETIME-relative ns is overkill.
  // Use Date.now() * 1e6 as a proxy — close enough since we're capturing
  // at creation time anyway. The reconciler treats this as opaque identity.
  return Date.now() * 1_000_000;
}

const raw = await readStdin();
let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }
const sessionId = payload?.session_id;
if (!sessionId || typeof sessionId !== 'string') process.exit(0);

const dir = join(homedir(), '.brainhouse', 'events');
mkdirSync(dir, { recursive: true });

const rec = {
  kind: 'session_pid',
  session_id: sessionId,
  pid: process.ppid,
  ppid: -1, // we don't know the grandparent and don't need it
  cwd: process.cwd(),
  start_ts: startTsNs(process.ppid),
  ts: Date.now() / 1000,
};
appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
```

- [ ] **Step 4: Run test, verify it passes**

```
npx vitest run hooks/session-start-procs.test.mjs
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```
git add hooks/session-start-procs.mjs hooks/session-start-procs.test.mjs
git commit -m "hooks: SessionStart writes session_pid record"
```

---

## Task 2: PreToolUse hook — emit bash_intent record

**Files:**
- Create: `hooks/pre-tool-use-bash.mjs`
- Create: `hooks/pre-tool-use-bash.test.mjs`

Claude Code's PreToolUse payload (per Claude Code docs) is `{session_id, tool_name, tool_input, ...}`. We only act when `tool_name === 'Bash'`. Record fields: `session_id`, `ts`, `command`, `run_in_background`, `cwd`.

- [ ] **Step 1: Write failing test**

`hooks/pre-tool-use-bash.test.mjs`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('./pre-tool-use-bash.mjs', import.meta.url).pathname;

function run(input, home) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

describe('pre-tool-use-bash hook', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bh-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('records a bash_intent for a Bash call', () => {
    const res = run({
      session_id: 's2',
      tool_name: 'Bash',
      tool_input: { command: 'npm run dev', run_in_background: true, description: 'start dev' },
      cwd: '/tmp/proj',
    }, home);
    expect(res.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(home, '.brainhouse/events/s2.jsonl'), 'utf8').trim());
    expect(rec.kind).toBe('bash_intent');
    expect(rec.session_id).toBe('s2');
    expect(rec.command).toBe('npm run dev');
    expect(rec.run_in_background).toBe(true);
    expect(rec.cwd).toBe('/tmp/proj');
    expect(typeof rec.ts).toBe('number');
  });

  it('ignores non-Bash tools', () => {
    const res = run({ session_id: 's2', tool_name: 'Read', tool_input: { file_path: '/x' } }, home);
    expect(res.status).toBe(0);
    expect(existsSync(join(home, '.brainhouse/events/s2.jsonl'))).toBe(false);
  });

  it('defaults run_in_background to false when absent', () => {
    run({ session_id: 's3', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' }, home);
    const rec = JSON.parse(readFileSync(join(home, '.brainhouse/events/s3.jsonl'), 'utf8').trim());
    expect(rec.run_in_background).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
npx vitest run hooks/pre-tool-use-bash.test.mjs
```

Expected: FAIL — missing module.

- [ ] **Step 3: Implement**

`hooks/pre-tool-use-bash.mjs`:

```javascript
#!/usr/bin/env node
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function readStdin() {
  let buf = '';
  for await (const c of process.stdin) buf += c;
  return buf;
}

const raw = await readStdin();
let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

if (payload?.tool_name !== 'Bash') process.exit(0);
const sessionId = payload?.session_id;
if (!sessionId) process.exit(0);

const input = payload.tool_input ?? {};
const rec = {
  kind: 'bash_intent',
  session_id: sessionId,
  command: typeof input.command === 'string' ? input.command : '',
  run_in_background: input.run_in_background === true,
  cwd: typeof payload.cwd === 'string' ? payload.cwd : (typeof input.cwd === 'string' ? input.cwd : ''),
  ts: Date.now() / 1000,
};

const dir = join(homedir(), '.brainhouse', 'events');
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
```

- [ ] **Step 4: Run test, verify it passes**

```
npx vitest run hooks/pre-tool-use-bash.test.mjs
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add hooks/pre-tool-use-bash.mjs hooks/pre-tool-use-bash.test.mjs
git commit -m "hooks: PreToolUse Bash writes bash_intent record"
```

---

## Task 3: PostToolUse hook — emit bash_id_map for backgrounded Bash

**Files:**
- Create: `hooks/post-tool-use-bash.mjs`
- Create: `hooks/post-tool-use-bash.test.mjs`

Claude Code's PostToolUse payload includes `tool_response`. For backgrounded shell calls, the response contains a `bash_id` we can later use to pull stdout via `BashOutput`. We record `{tool_use_id, bash_id, session_id}`.

- [ ] **Step 1: Write failing test**

`hooks/post-tool-use-bash.test.mjs`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('./post-tool-use-bash.mjs', import.meta.url).pathname;
const run = (input, home) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify(input), env: { ...process.env, HOME: home }, encoding: 'utf8',
});

describe('post-tool-use-bash hook', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bh-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('records bash_id_map for backgrounded Bash', () => {
    run({
      session_id: 's4',
      tool_name: 'Bash',
      tool_use_id: 'tu_42',
      tool_input: { command: 'npm run dev', run_in_background: true },
      tool_response: { bash_id: 'bg_1' },
    }, home);
    const rec = JSON.parse(readFileSync(join(home, '.brainhouse/events/s4.jsonl'), 'utf8').trim());
    expect(rec.kind).toBe('bash_id_map');
    expect(rec.tool_use_id).toBe('tu_42');
    expect(rec.bash_id).toBe('bg_1');
    expect(rec.session_id).toBe('s4');
  });

  it('no-ops for foreground Bash', () => {
    run({
      session_id: 's5',
      tool_name: 'Bash',
      tool_use_id: 'tu_43',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a\nb\n' },
    }, home);
    expect(existsSync(join(home, '.brainhouse/events/s5.jsonl'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run hooks/post-tool-use-bash.test.mjs`

- [ ] **Step 3: Implement**

`hooks/post-tool-use-bash.mjs`:

```javascript
#!/usr/bin/env node
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function readStdin() {
  let buf = '';
  for await (const c of process.stdin) buf += c;
  return buf;
}

const raw = await readStdin();
let p; try { p = JSON.parse(raw); } catch { process.exit(0); }

if (p?.tool_name !== 'Bash') process.exit(0);
if (p?.tool_input?.run_in_background !== true) process.exit(0);
const bashId = p?.tool_response?.bash_id;
if (!bashId) process.exit(0);

const rec = {
  kind: 'bash_id_map',
  session_id: p.session_id,
  tool_use_id: p.tool_use_id,
  bash_id: bashId,
  ts: Date.now() / 1000,
};

const dir = join(homedir(), '.brainhouse', 'events');
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, `${p.session_id}.jsonl`), JSON.stringify(rec) + '\n');
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add hooks/post-tool-use-bash.mjs hooks/post-tool-use-bash.test.mjs
git commit -m "hooks: PostToolUse Bash writes bash_id_map for backgrounded shells"
```

---

## Task 4: Extend HookEventSchema with new kinds

**Files:**
- Modify: `server/src/hookEvents.ts`

The server already parses hook records via `HookEventSchema` (Zod). Add the new discriminator kinds and their fields.

- [ ] **Step 1: Read current schema, identify the union**

```
cat /Users/mike/src/brainhouse/server/src/hookEvents.ts
```

Note the exact shape of the `kind` enum and the optional-fields-soup pattern.

- [ ] **Step 2: Write failing test**

`server/src/hookEvents.test.ts` (create or append):

```typescript
import { describe, it, expect } from 'vitest';
import { HookEventSchema } from './hookEvents.js';

describe('HookEventSchema — process kinds', () => {
  it('parses session_pid', () => {
    const r = HookEventSchema.parse({
      kind: 'session_pid',
      session_id: 's1',
      pid: 123,
      ppid: 1,
      cwd: '/x',
      start_ts: 999,
      ts: 1.5,
    });
    expect(r.kind).toBe('session_pid');
    expect(r.pid).toBe(123);
  });

  it('parses bash_intent', () => {
    const r = HookEventSchema.parse({
      kind: 'bash_intent',
      session_id: 's1',
      command: 'npm run dev',
      run_in_background: true,
      cwd: '/x',
      ts: 1.5,
    });
    expect(r.command).toBe('npm run dev');
    expect(r.run_in_background).toBe(true);
  });

  it('parses bash_id_map', () => {
    const r = HookEventSchema.parse({
      kind: 'bash_id_map',
      session_id: 's1',
      tool_use_id: 'tu1',
      bash_id: 'bg1',
      ts: 1.5,
    });
    expect(r.bash_id).toBe('bg1');
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

```
cd server && npx vitest run src/hookEvents.test.ts
```

Expected: FAIL — unknown discriminator values.

- [ ] **Step 4: Modify schema**

In `server/src/hookEvents.ts`, extend the `kind` enum to include `'session_pid' | 'bash_intent' | 'bash_id_map'` and add the new optional fields:

```typescript
// Add to the kind z.enum([...]) list:
'session_pid', 'bash_intent', 'bash_id_map',

// Add these optional fields to the object schema:
pid: z.number().optional(),
ppid: z.number().optional(),
cwd: z.string().optional(),
start_ts: z.number().optional(),
command: z.string().optional(),
run_in_background: z.boolean().optional(),
tool_use_id: z.string().optional(),
bash_id: z.string().optional(),
```

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```
git add server/src/hookEvents.ts server/src/hookEvents.test.ts
git commit -m "server: extend HookEventSchema with process-tracking kinds"
```

---

## Task 5: Native shell wrappers (`processes/native.ts`)

**Files:**
- Create: `server/src/processes/native.ts`
- Create: `server/src/processes/native.test.ts`

Wraps `ps`, `lsof`, `kill`. Pure functions returning parsed shapes. This file is the **host-isolation boundary**: a future remote-host sidecar replaces only this file.

- [ ] **Step 1: Define types and write failing tests**

`server/src/processes/native.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { listProcesses, listListeningPorts, signalProcess, parsePsOutput, parseLsofOutput } from './native.js';

describe('parsePsOutput', () => {
  it('extracts pid/ppid/start/comm/command', () => {
    const sample = `  PID  PPID                      LSTART COMM             COMMAND
    1     0 Thu Jun  5 09:00:00 2025 launchd          /sbin/launchd
12345 12300 Thu Jun  5 10:30:15 2025 node             /usr/local/bin/node /x/bin/vite
`;
    const rows = parsePsOutput(sample);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      pid: 12345, ppid: 12300, comm: 'node',
      command: '/usr/local/bin/node /x/bin/vite',
    });
    expect(typeof rows[1].start_ts).toBe('number');
  });
});

describe('parseLsofOutput', () => {
  it('parses -F pPn into per-pid listening sockets', () => {
    const sample = `p4823
PTCP
n127.0.0.1:5173
PTCP
n*:24678
p4901
PTCP
n0.0.0.0:8000
`;
    const rows = parseLsofOutput(sample);
    expect(rows).toEqual([
      { pid: 4823, ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }, { proto: 'TCP', addr: '*', port: 24678 }] },
      { pid: 4901, ports: [{ proto: 'TCP', addr: '0.0.0.0', port: 8000 }] },
    ]);
  });
});

describe('listProcesses (integration)', () => {
  it('returns this process', async () => {
    const rows = await listProcesses();
    const me = rows.find(r => r.pid === process.pid);
    expect(me).toBeDefined();
    expect(me!.command).toContain('node');
  });
});

describe('signalProcess', () => {
  it('refuses pids <= 1000', async () => {
    await expect(signalProcess(1, 'TERM')).rejects.toThrow(/refused/i);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```
cd server && npx vitest run src/processes/native.test.ts
```

- [ ] **Step 3: Implement `native.ts`**

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PsRow = { pid: number; ppid: number; start_ts: number; comm: string; command: string };
export type PortRow = { pid: number; ports: Array<{ proto: 'TCP'; addr: string; port: number }> };

export function parsePsOutput(out: string): PsRow[] {
  const lines = out.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  // First line is the header
  const rows: PsRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // ps -o pid,ppid,lstart,comm,command emits: PID PPID Day Mon DD HH:MM:SS YYYY COMM COMMAND
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+[ \d]\d\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      start_ts: Date.parse(m[3]) * 1_000_000, // ns
      comm: m[4],
      command: m[5],
    });
  }
  return rows;
}

export function parseLsofOutput(out: string): PortRow[] {
  // -F pPn emits records: p<pid>\nP<proto>\nn<addr:port>\nP<proto>\nn<addr:port>\np<nextpid>...
  const rows: PortRow[] = [];
  let cur: PortRow | null = null;
  let pendingProto: 'TCP' | null = null;
  for (const raw of out.split('\n')) {
    if (raw.length === 0) continue;
    const tag = raw[0]; const val = raw.slice(1);
    if (tag === 'p') {
      if (cur) rows.push(cur);
      cur = { pid: parseInt(val, 10), ports: [] };
      pendingProto = null;
    } else if (tag === 'P') {
      pendingProto = val === 'TCP' ? 'TCP' : null;
    } else if (tag === 'n' && cur && pendingProto === 'TCP') {
      const idx = val.lastIndexOf(':');
      if (idx > 0) {
        const addr = val.slice(0, idx);
        const port = parseInt(val.slice(idx + 1), 10);
        if (Number.isFinite(port)) cur.ports.push({ proto: 'TCP', addr, port });
      }
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

export async function listProcesses(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync(
    'ps', ['-A', '-o', 'pid,ppid,lstart,comm,command'],
    { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
  );
  return parsePsOutput(stdout);
}

export async function listListeningPorts(): Promise<PortRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pPn'],
      { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseLsofOutput(stdout);
  } catch {
    return [];
  }
}

export async function signalProcess(pid: number, sig: 'TERM' | 'KILL'): Promise<void> {
  if (pid <= 1000) throw new Error(`refused: pid ${pid} is system-reserved`);
  try { process.kill(pid, sig === 'TERM' ? 'SIGTERM' : 'SIGKILL'); }
  catch (e: any) { if (e.code !== 'ESRCH') throw e; }
}
```

- [ ] **Step 4: Run, expect PASS**

```
cd server && npx vitest run src/processes/native.test.ts
```

- [ ] **Step 5: Commit**

```
git add server/src/processes/native.ts server/src/processes/native.test.ts
git commit -m "server: native shellouts for ps, lsof, kill"
```

---

## Task 6: Runtime detection (`processes/runtime.ts`)

**Files:**
- Create: `server/src/processes/runtime.ts`
- Create: `server/src/processes/runtime.test.ts`

Three-step strategy: path inspection → cached `<exe> --version` probe → argv heuristic.

- [ ] **Step 1: Failing tests**

`server/src/processes/runtime.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectRuntimeFromPath, detectRuntimeFromArgv } from './runtime.js';

describe('detectRuntimeFromPath', () => {
  it('nvm', () => {
    expect(detectRuntimeFromPath('/Users/x/.nvm/versions/node/v22.5.0/bin/node'))
      .toEqual({ runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path' });
  });
  it('asdf python', () => {
    expect(detectRuntimeFromPath('/Users/x/.asdf/installs/python/3.12.4/bin/python3.12'))
      .toEqual({ runtime: 'python', runtime_version: '3.12.4', runtime_source: 'path' });
  });
  it('rbenv ruby', () => {
    expect(detectRuntimeFromPath('/Users/x/.rbenv/versions/3.3.0/bin/ruby'))
      .toEqual({ runtime: 'ruby', runtime_version: '3.3.0', runtime_source: 'path' });
  });
  it('volta', () => {
    expect(detectRuntimeFromPath('/Users/x/.volta/tools/image/node/20.10.0/bin/node'))
      .toEqual({ runtime: 'node', runtime_version: '20.10.0', runtime_source: 'path' });
  });
  it('returns null when no match', () => {
    expect(detectRuntimeFromPath('/usr/bin/node')).toBeNull();
  });
});

describe('detectRuntimeFromArgv', () => {
  it('python3.12 from argv0', () => {
    expect(detectRuntimeFromArgv(['python3.12', '-m', 'http.server']))
      .toEqual({ runtime: 'python', runtime_version: '3.12', runtime_source: 'argv' });
  });
  it('node with no version', () => {
    expect(detectRuntimeFromArgv(['node', 'index.js']))
      .toEqual({ runtime: 'node', runtime_version: null, runtime_source: 'argv' });
  });
  it('postgres', () => {
    expect(detectRuntimeFromArgv(['/usr/local/bin/postgres', '-D', '/var/pg']))
      .toEqual({ runtime: 'postgres', runtime_version: null, runtime_source: 'argv' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`server/src/processes/runtime.ts`:

```typescript
export type Runtime = { runtime: string; runtime_version: string | null; runtime_source: 'path' | 'probe' | 'argv' };

const PATH_PATTERNS: Array<{ runtime: string; re: RegExp }> = [
  { runtime: 'node',   re: /\.nvm\/versions\/node\/v?(\d+\.\d+\.\d+)\// },
  { runtime: 'node',   re: /\.volta\/tools\/image\/node\/(\d+\.\d+\.\d+)\// },
  { runtime: 'node',   re: /\.fnm\/node-versions\/v(\d+\.\d+\.\d+)\// },
  { runtime: 'node',   re: /\.asdf\/installs\/nodejs\/(\d+\.\d+\.\d+)\// },
  { runtime: 'python', re: /\.asdf\/installs\/python\/(\d+\.\d+\.\d+)\// },
  { runtime: 'python', re: /\.pyenv\/versions\/(\d+\.\d+\.\d+)\// },
  { runtime: 'ruby',   re: /\.rbenv\/versions\/(\d+\.\d+\.\d+)\// },
  { runtime: 'ruby',   re: /\.asdf\/installs\/ruby\/(\d+\.\d+\.\d+)\// },
  { runtime: 'bun',    re: /\.bun\/install\/global\/.*?\/(\d+\.\d+\.\d+)\// },
  { runtime: 'deno',   re: /\.deno\/bin\// }, // version unknown from path
];

export function detectRuntimeFromPath(exePath: string): Runtime | null {
  for (const { runtime, re } of PATH_PATTERNS) {
    const m = exePath.match(re);
    if (m) return { runtime, runtime_version: m[1] ?? null, runtime_source: 'path' };
  }
  return null;
}

const ARGV0_KNOWN: Record<string, string> = {
  node: 'node', bun: 'bun', deno: 'deno', ruby: 'ruby', php: 'php',
  go: 'go', cargo: 'cargo', java: 'java', postgres: 'postgres', redis: 'redis', mysql: 'mysql',
};

export function detectRuntimeFromArgv(argv: string[]): Runtime | null {
  if (argv.length === 0) return null;
  const head = argv[0].split('/').pop() ?? argv[0];
  // pythonN.M pattern
  const py = head.match(/^python(\d+\.\d+)?$/);
  if (py) return { runtime: 'python', runtime_version: py[1] ?? null, runtime_source: 'argv' };
  const known = ARGV0_KNOWN[head];
  if (known) return { runtime: known, runtime_version: null, runtime_source: 'argv' };
  return null;
}

// Probe is wired in Task 8 (reconciler) so it can use an injected execFile + cache.
// We expose detectRuntimeFromPath + detectRuntimeFromArgv as pure functions here.
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add server/src/processes/runtime.ts server/src/processes/runtime.test.ts
git commit -m "server: runtime detection from path + argv"
```

---

## Task 7: Framework detection (`processes/framework.ts`)

**Files:**
- Create: `server/src/processes/framework.ts`
- Create: `server/src/processes/framework.test.ts`

Argv scan for known framework paths; version from sibling `package.json` (file IO, cached).

- [ ] **Step 1: Failing tests**

`server/src/processes/framework.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFrameworkFromArgv, readPackageVersion } from './framework.js';

describe('detectFrameworkFromArgv', () => {
  it('vite via node_modules', () => {
    const r = detectFrameworkFromArgv(['node', '/x/proj/node_modules/vite/bin/vite.js']);
    expect(r).toMatchObject({ framework: 'vite', package_path: '/x/proj/node_modules/vite' });
  });
  it('next dev', () => {
    const r = detectFrameworkFromArgv(['node', '/x/proj/node_modules/next/dist/bin/next', 'dev']);
    expect(r?.framework).toBe('next');
  });
  it('django runserver', () => {
    const r = detectFrameworkFromArgv(['python', 'manage.py', 'runserver']);
    expect(r?.framework).toBe('django');
  });
  it('rails server', () => {
    const r = detectFrameworkFromArgv(['ruby', 'bin/rails', 'server']);
    expect(r?.framework).toBe('rails');
  });
  it('astro / nuxt / remix / webpack-dev-server', () => {
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/astro/astro.js'])?.framework).toBe('astro');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/nuxt/bin/nuxt.mjs'])?.framework).toBe('nuxt');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/@remix-run/dev/dist/cli.js'])?.framework).toBe('remix');
    expect(detectFrameworkFromArgv(['node', '/p/node_modules/webpack-dev-server/bin/webpack-dev-server.js'])?.framework).toBe('webpack-dev-server');
  });
});

describe('readPackageVersion', () => {
  it('reads version from package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
    expect(readPackageVersion(dir)).toBe('1.2.3');
  });
  it('returns null when missing', () => {
    expect(readPackageVersion('/nonexistent-' + Date.now())).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`server/src/processes/framework.ts`:

```typescript
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FrameworkHit = { framework: string; package_path: string | null };

const PATTERNS: Array<{ framework: string; re: RegExp; pkgGroup?: number }> = [
  { framework: 'vite',                re: /(.*\/node_modules\/vite)(\/|$)/,             pkgGroup: 1 },
  { framework: 'next',                re: /(.*\/node_modules\/next)(\/|$)/,             pkgGroup: 1 },
  { framework: 'astro',               re: /(.*\/node_modules\/astro)(\/|$)/,            pkgGroup: 1 },
  { framework: 'nuxt',                re: /(.*\/node_modules\/nuxt)(\/|$)/,             pkgGroup: 1 },
  { framework: 'remix',               re: /(.*\/node_modules\/@remix-run\/dev)(\/|$)/,  pkgGroup: 1 },
  { framework: 'webpack-dev-server',  re: /(.*\/node_modules\/webpack-dev-server)(\/|$)/, pkgGroup: 1 },
  { framework: 'rails',               re: /\/bin\/rails(\s|$)/ },
  { framework: 'django',              re: /manage\.py(\s|$)/ },
  { framework: 'flask',               re: /flask(\s|$)/ },
];

export function detectFrameworkFromArgv(argv: string[]): FrameworkHit | null {
  const joined = argv.join(' ');
  for (const p of PATTERNS) {
    const m = joined.match(p.re);
    if (m) return { framework: p.framework, package_path: p.pkgGroup ? m[p.pkgGroup] : null };
  }
  return null;
}

const versionCache = new Map<string, { mtime: number; version: string | null }>();

export function readPackageVersion(packagePath: string): string | null {
  try {
    const pj = join(packagePath, 'package.json');
    if (!existsSync(pj)) return null;
    const st = statSync(pj);
    const cached = versionCache.get(pj);
    if (cached && cached.mtime === st.mtimeMs) return cached.version;
    const v = (JSON.parse(readFileSync(pj, 'utf8')).version as string) ?? null;
    versionCache.set(pj, { mtime: st.mtimeMs, version: v });
    return v;
  } catch { return null; }
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add server/src/processes/framework.ts server/src/processes/framework.test.ts
git commit -m "server: framework detection from argv + package.json"
```

---

## Task 8: Reconciler (`processes/reconciler.ts`) — table, tree walker, intent matcher, death rule

**Files:**
- Create: `server/src/processes/reconciler.ts`
- Create: `server/src/processes/reconciler.test.ts`

This is the heart. Pure logic: given (current `ps` snapshot, session_pids map, bash_intent buffer, prior table state), produce (next table state, list of upserts, list of deletes).

Keep all side effects (ps invocation, lsof, time) injectable so we can test deterministically.

- [ ] **Step 1: Failing tests**

`server/src/processes/reconciler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Reconciler } from './reconciler.js';
import type { PsRow } from './native.js';

const baseProc = (over: Partial<PsRow>): PsRow => ({
  pid: 100, ppid: 1, start_ts: 1000, comm: 'node', command: 'node x', ...over,
});

describe('Reconciler', () => {
  it('attributes a new descendant to its session', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 50, command: 'node /p/node_modules/vite/bin/vite.js' }),
    ], 5000);
    const vite = upserts.find(u => u.pid === 100);
    expect(vite).toBeDefined();
    expect(vite!.session_id).toBe('s1');
    expect(vite!.provenance).toBe('observed');
    expect(vite!.framework).toBe('vite');
  });

  it('promotes provenance to hooked when bash_intent matches', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.recordBashIntent('s1', { command: 'npm run dev', run_in_background: true, cwd: '/p', ts: 4.9 });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 50, start_ts: 5_000_000_000, command: 'node vite' }),
    ], 5);
    const row = upserts.find(u => u.pid === 100)!;
    expect(row.provenance).toBe('hooked');
    expect(row.hook_command).toBe('npm run dev');
    expect(row.run_in_background).toBe(true);
  });

  it('does not emit deltas for sub-3s commands with no port and no run_in_background', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1 }),
      baseProc({ pid: 100, ppid: 50, comm: 'grep', command: 'grep foo' }),
    ], 1);
    expect(upserts.find(u => u.pid === 100)).toBeUndefined();
  });

  it('two-tick absence rule', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.tick([
      baseProc({ pid: 50 }),
      baseProc({ pid: 100, ppid: 50, command: 'node x', start_ts: 0 }),
    ], 4); // qualifies (uptime 4s)
    // First missing tick: no delete yet
    let result = r.tick([baseProc({ pid: 50 })], 6);
    expect(result.deletes).toHaveLength(0);
    // Second missing tick: delete
    result = r.tick([baseProc({ pid: 50 })], 8);
    expect(result.deletes).toHaveLength(1);
  });

  it('heuristic attribution by cwd when not in tree', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1 }),
      baseProc({ pid: 200, ppid: 1, command: 'node x', start_ts: 0 }),
    ], 5, /* cwdLookup */ (pid) => pid === 200 ? '/p' : null);
    const row = upserts.find(u => u.pid === 200);
    expect(row?.provenance).toBe('heuristic');
    expect(row?.session_id).toBe('s1');
  });

  it('PID recycling: same pid, different start_ts → new row', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.tick([baseProc({ pid: 50 }), baseProc({ pid: 100, ppid: 50, start_ts: 1, command: 'node a' })], 5);
    r.tick([baseProc({ pid: 50 }), baseProc({ pid: 100, ppid: 50, start_ts: 1, command: 'node a' })], 6);
    const result = r.tick([baseProc({ pid: 50 }), baseProc({ pid: 100, ppid: 50, start_ts: 999, command: 'node b' })], 7);
    expect(result.deletes.length + result.upserts.length).toBeGreaterThanOrEqual(2);
    const newRow = result.upserts.find(u => u.command === 'node b');
    expect(newRow).toBeDefined();
    expect(newRow!.process_id).not.toBe('p_local_100_1');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`server/src/processes/reconciler.ts`:

```typescript
import type { PsRow } from './native.js';
import { detectRuntimeFromPath, detectRuntimeFromArgv } from './runtime.js';
import { detectFrameworkFromArgv, readPackageVersion } from './framework.js';

export type Provenance = 'hooked' | 'observed' | 'heuristic' | 'discovered';

export interface ProcessRow {
  process_id: string;
  host: 'local';
  pid: number; ppid: number; start_ts: number;
  command: string; cwd: string | null;
  session_id: string | null;
  hook_command: string | null;
  run_in_background: boolean;
  provenance: Provenance;
  runtime: string | null; runtime_version: string | null; runtime_source: string | null;
  framework: string | null; framework_version: string | null;
  ports: Array<{ proto: 'TCP'; addr: string; port: number }>;
  ended_ts: number | null; ended_reason: string | null;
  uptime_s: number;
}

interface SessionInfo { pid: number; cwd: string; }
interface BashIntent { command: string; run_in_background: boolean; cwd: string; ts: number; }

const SIGNAL_MIN_UPTIME_S = 3;
const INTENT_TTL_S = 30;
const INTENT_BUFFER_SIZE = 50;
const INTENT_MATCH_WINDOW_S = 2;

export class Reconciler {
  private sessions = new Map<string, SessionInfo>();
  private intents = new Map<string, BashIntent[]>();
  private rows = new Map<string, ProcessRow>(); // by process_id
  private missingTicks = new Map<string, number>(); // process_id -> consecutive missing
  private broadcasted = new Set<string>(); // process_ids we've sent upserts for

  registerSession(sessionId: string, info: SessionInfo) { this.sessions.set(sessionId, info); }
  unregisterSession(sessionId: string) { this.sessions.delete(sessionId); this.intents.delete(sessionId); }
  recordBashIntent(sessionId: string, intent: BashIntent) {
    const arr = this.intents.get(sessionId) ?? [];
    arr.push(intent);
    while (arr.length > INTENT_BUFFER_SIZE) arr.shift();
    this.intents.set(sessionId, arr);
  }

  tick(
    ps: PsRow[],
    nowS: number,
    cwdLookup?: (pid: number) => string | null,
  ): { upserts: ProcessRow[]; deletes: string[] } {
    // Build pid → row map and parent map
    const byPid = new Map<number, PsRow>();
    for (const p of ps) byPid.set(p.pid, p);

    // Compute descendant set per session
    const sessionOf = new Map<number, string>();
    for (const [sid, info] of this.sessions) {
      // BFS descendants
      const stack = [info.pid];
      const seen = new Set<number>([info.pid]);
      while (stack.length) {
        const parent = stack.pop()!;
        for (const p of ps) {
          if (p.ppid === parent && !seen.has(p.pid)) {
            seen.add(p.pid);
            sessionOf.set(p.pid, sid);
            stack.push(p.pid);
          }
        }
      }
    }

    const presentIds = new Set<string>();
    const upserts: ProcessRow[] = [];

    for (const p of ps) {
      const processId = `p_local_${p.pid}_${p.start_ts}`;
      presentIds.add(processId);

      let row = this.rows.get(processId);
      if (!row) {
        // Detect prior row with same pid but different start_ts (recycling)
        for (const [oldId, oldRow] of this.rows) {
          if (oldRow.pid === p.pid && oldRow.start_ts !== p.start_ts) {
            this.rows.delete(oldId);
            this.missingTicks.delete(oldId);
          }
        }
        row = this.createRow(processId, p, sessionOf.get(p.pid) ?? null, cwdLookup?.(p.pid) ?? null);
        this.rows.set(processId, row);
      }

      // Update mutable fields each tick
      const sid = sessionOf.get(p.pid) ?? row.session_id;
      if (sid && !row.session_id) row.session_id = sid;
      // Heuristic cwd attribution if not in tree
      if (!row.session_id && cwdLookup) {
        const cwd = cwdLookup(p.pid);
        if (cwd) {
          for (const [s, info] of this.sessions) {
            if (info.cwd === cwd) { row.session_id = s; row.provenance = 'heuristic'; break; }
          }
        }
      }

      // Intent matching (only if not already hooked)
      if (row.session_id && row.provenance === 'observed') {
        const intents = this.intents.get(row.session_id) ?? [];
        const procStartS = p.start_ts / 1_000_000_000;
        const match = intents.find(i => Math.abs(i.ts - procStartS) <= INTENT_MATCH_WINDOW_S);
        if (match) {
          row.provenance = 'hooked';
          row.hook_command = match.command;
          row.run_in_background = match.run_in_background;
        }
      }

      row.uptime_s = nowS - p.start_ts / 1_000_000_000;
      this.missingTicks.delete(processId);

      // Decide whether to broadcast
      const qualifies = row.run_in_background || row.uptime_s >= SIGNAL_MIN_UPTIME_S || row.ports.length > 0;
      if (qualifies) {
        upserts.push(row);
        this.broadcasted.add(processId);
      }
    }

    // Absence handling
    const deletes: string[] = [];
    for (const [id, row] of this.rows) {
      if (presentIds.has(id)) continue;
      const n = (this.missingTicks.get(id) ?? 0) + 1;
      if (n >= 2) {
        row.ended_ts = nowS;
        row.ended_reason = row.ended_reason ?? 'lost';
        if (this.broadcasted.has(id)) deletes.push(id);
        this.rows.delete(id);
        this.missingTicks.delete(id);
        this.broadcasted.delete(id);
      } else {
        this.missingTicks.set(id, n);
      }
    }

    // Prune stale intents
    for (const [sid, arr] of this.intents) {
      this.intents.set(sid, arr.filter(i => nowS - i.ts < INTENT_TTL_S));
    }

    return { upserts, deletes };
  }

  setPorts(processId: string, ports: ProcessRow['ports']) {
    const row = this.rows.get(processId);
    if (row) row.ports = ports;
  }

  getRow(processId: string): ProcessRow | undefined { return this.rows.get(processId); }
  getRows(): ProcessRow[] { return Array.from(this.rows.values()); }
  rowByPid(pid: number): ProcessRow | undefined {
    for (const r of this.rows.values()) if (r.pid === pid) return r;
    return undefined;
  }

  private createRow(id: string, p: PsRow, sessionId: string | null, cwd: string | null): ProcessRow {
    const argv = p.command.split(/\s+/);
    const rtPath = detectRuntimeFromPath(argv[0] ?? '');
    const rtArgv = rtPath ? null : detectRuntimeFromArgv(argv);
    const rt = rtPath ?? rtArgv;
    const fw = detectFrameworkFromArgv(argv);
    return {
      process_id: id, host: 'local',
      pid: p.pid, ppid: p.ppid, start_ts: p.start_ts,
      command: p.command, cwd,
      session_id: sessionId,
      hook_command: null, run_in_background: false,
      provenance: sessionId ? 'observed' : 'discovered',
      runtime: rt?.runtime ?? null, runtime_version: rt?.runtime_version ?? null, runtime_source: rt?.runtime_source ?? null,
      framework: fw?.framework ?? null,
      framework_version: fw?.package_path ? readPackageVersion(fw.package_path) : null,
      ports: [],
      ended_ts: null, ended_reason: null,
      uptime_s: 0,
    };
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```
cd server && npx vitest run src/processes/reconciler.test.ts
```

- [ ] **Step 5: Commit**

```
git add server/src/processes/reconciler.ts server/src/processes/reconciler.test.ts
git commit -m "server: process reconciler with tiered provenance + two-tick absence"
```

---

## Task 9: Port sweeper + tracker top-level orchestration (`processes/index.ts`)

**Files:**
- Create: `server/src/processes/index.ts`
- Create: `server/src/processes/index.test.ts`

`ProcessTracker` owns the timers, accepts hook records, drives the reconciler, emits delta events.

- [ ] **Step 1: Failing test**

`server/src/processes/index.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ProcessTracker } from './index.js';

describe('ProcessTracker', () => {
  it('emits process_upsert when a qualifying process appears', async () => {
    const psFake = vi.fn().mockResolvedValueOnce([
      { pid: 50, ppid: 1, start_ts: 0, comm: 'node', command: 'claude' },
      { pid: 100, ppid: 50, start_ts: 0, comm: 'node', command: 'node /p/node_modules/vite/bin/vite.js' },
    ]);
    const t = new ProcessTracker({
      listProcesses: psFake,
      listListeningPorts: async () => [],
      now: () => 10,
    });
    const events: any[] = [];
    t.on('upsert', r => events.push({ kind: 'upsert', r }));
    t.on('delete', id => events.push({ kind: 'delete', id }));
    t.handleHookRecord({ kind: 'session_pid', session_id: 's1', pid: 50, ppid: 1, cwd: '/p', start_ts: 0, ts: 0 } as any);
    await t.tickOnce();
    expect(events.some(e => e.kind === 'upsert' && e.r.framework === 'vite')).toBe(true);
  });

  it('port sweeper idles when no subscribers', async () => {
    const lsof = vi.fn().mockResolvedValue([]);
    const t = new ProcessTracker({
      listProcesses: async () => [],
      listListeningPorts: lsof,
      now: () => 0,
    });
    await t.maybeSweepPorts();
    expect(lsof).not.toHaveBeenCalled();
    t.addSubscriber();
    await t.maybeSweepPorts();
    expect(lsof).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`server/src/processes/index.ts`:

```typescript
import { EventEmitter } from 'node:events';
import { Reconciler, type ProcessRow } from './reconciler.js';
import { listProcesses as realListProcesses, listListeningPorts as realListPorts, signalProcess } from './native.js';

export type TrackerDeps = {
  listProcesses?: typeof realListProcesses;
  listListeningPorts?: typeof realListPorts;
  now?: () => number;
};

export class ProcessTracker extends EventEmitter {
  private rec = new Reconciler();
  private subscribers = 0;
  private listProcesses: typeof realListProcesses;
  private listPorts: typeof realListPorts;
  private now: () => number;
  private tickTimer?: NodeJS.Timeout;
  private portTimer?: NodeJS.Timeout;

  constructor(deps: TrackerDeps = {}) {
    super();
    this.listProcesses = deps.listProcesses ?? realListProcesses;
    this.listPorts = deps.listListeningPorts ?? realListPorts;
    this.now = deps.now ?? (() => Date.now() / 1000);
  }

  start() {
    this.tickTimer = setInterval(() => { void this.tickOnce(); }, 1000);
    this.portTimer = setInterval(() => { void this.maybeSweepPorts(); }, 5000);
  }
  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.portTimer) clearInterval(this.portTimer);
  }

  addSubscriber() { this.subscribers++; }
  removeSubscriber() { this.subscribers = Math.max(0, this.subscribers - 1); }

  snapshot(): ProcessRow[] { return this.rec.getRows(); }

  handleHookRecord(rec: any) {
    if (rec.kind === 'session_pid') {
      this.rec.registerSession(rec.session_id, { pid: rec.pid, cwd: rec.cwd ?? '' });
    } else if (rec.kind === 'bash_intent') {
      this.rec.recordBashIntent(rec.session_id, {
        command: rec.command ?? '', run_in_background: rec.run_in_background ?? false,
        cwd: rec.cwd ?? '', ts: rec.ts,
      });
    } else if (rec.kind === 'session_end' || rec.kind === 'stop') {
      this.rec.unregisterSession(rec.session_id);
    }
  }

  async tickOnce() {
    try {
      const ps = await this.listProcesses();
      const { upserts, deletes } = this.rec.tick(ps, this.now());
      for (const r of upserts) this.emit('upsert', r);
      for (const id of deletes) this.emit('delete', id);
    } catch (e) {
      // log + skip; never crash the server
      console.error('[processes] tick failed:', e);
    }
  }

  async maybeSweepPorts() {
    if (this.subscribers === 0) return;
    try {
      const rows = await this.listPorts();
      for (const row of rows) {
        const procRow = this.rec.rowByPid(row.pid);
        if (procRow) {
          this.rec.setPorts(procRow.process_id, row.ports);
          this.emit('ports', { process_id: procRow.process_id, ports: row.ports });
        }
      }
    } catch (e) { console.error('[processes] port sweep failed:', e); }
  }

  async kill(processId: string): Promise<void> {
    const row = this.rec.getRow(processId);
    if (!row) throw new Error('process not tracked');
    await signalProcess(row.pid, 'TERM');
    setTimeout(() => { void signalProcess(row.pid, 'KILL').catch(() => {}); }, 3000);
    row.ended_reason = 'killed_by_user';
  }
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add server/src/processes/index.ts server/src/processes/index.test.ts
git commit -m "server: ProcessTracker orchestrates reconciler + timers + port sweep"
```

---

## Task 10: Startup discovery sweep (`processes/discovery.ts`)

**Files:**
- Create: `server/src/processes/discovery.ts`
- Create: `server/src/processes/discovery.test.ts`

On server boot, seed `processes` rows for already-listening ports as `provenance='discovered'`.

- [ ] **Step 1: Failing test**

`server/src/processes/discovery.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ProcessTracker } from './index.js';
import { runStartupDiscovery } from './discovery.js';

describe('runStartupDiscovery', () => {
  it('seeds rows for currently-listening ports with discovered provenance', async () => {
    const tracker = new ProcessTracker({
      listProcesses: async () => [
        { pid: 4242, ppid: 1, start_ts: 0, comm: 'postgres', command: '/usr/local/bin/postgres -D /var/pg' },
      ],
      listListeningPorts: async () => [
        { pid: 4242, ports: [{ proto: 'TCP' as const, addr: '0.0.0.0', port: 5432 }] },
      ],
      now: () => 100,
    });
    tracker.addSubscriber(); // so port sweep runs
    await runStartupDiscovery(tracker);
    const rows = tracker.snapshot();
    const pg = rows.find(r => r.pid === 4242);
    expect(pg).toBeDefined();
    expect(pg!.provenance).toBe('discovered');
    expect(pg!.ports[0].port).toBe(5432);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`server/src/processes/discovery.ts`:

```typescript
import type { ProcessTracker } from './index.js';

export async function runStartupDiscovery(tracker: ProcessTracker): Promise<void> {
  await tracker.tickOnce();
  await tracker.maybeSweepPorts();
}
```

(The reconciler already creates rows with `provenance='discovered'` when no session attributes the PID, and the port sweep fills `ports`. Discovery is the orchestration glue.)

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add server/src/processes/discovery.ts server/src/processes/discovery.test.ts
git commit -m "server: startup discovery sweep wires tracker initial state"
```

---

## Task 11: Extend Delta union + tRPC subscription

**Files:**
- Modify: `server/src/session.ts` (Delta union)
- Modify: `server/src/trpc.ts` (router)
- Modify: `server/src/index.ts` (construct tracker, wire to delta emitter)

- [ ] **Step 1: Read existing Delta union and trpc router shape**

```
sed -n '200,240p' /Users/mike/src/brainhouse/server/src/session.ts
cat /Users/mike/src/brainhouse/server/src/trpc.ts | head -100
```

- [ ] **Step 2: Extend Delta union in `session.ts`**

Find the `export type Delta = …` union (~line 207) and add three variants:

```typescript
  | { op: 'process_upsert'; process: ProcessRow }
  | { op: 'process_delete'; process_id: string }
  | { op: 'process_ports'; process_id: string; ports: Array<{ proto: 'TCP'; addr: string; port: number }> }
```

Add at top of file (or import from the processes module):

```typescript
import type { ProcessRow } from './processes/reconciler.js';
```

- [ ] **Step 3: Add `processes` tRPC router in `trpc.ts`**

```typescript
// After existing routers, before export:
processes: t.router({
  subscribe: t.procedure.subscription(({ ctx }) => {
    return observable<{ kind: 'snapshot'; rows: ProcessRow[] } | { kind: 'delta'; delta: ProcessDelta }>((emit) => {
      ctx.tracker.addSubscriber();
      emit.next({ kind: 'snapshot', rows: ctx.tracker.snapshot() });
      const onUpsert = (r: ProcessRow) => emit.next({ kind: 'delta', delta: { op: 'process_upsert', process: r } });
      const onDelete = (id: string) => emit.next({ kind: 'delta', delta: { op: 'process_delete', process_id: id } });
      const onPorts = (p: { process_id: string; ports: any[] }) => emit.next({ kind: 'delta', delta: { op: 'process_ports', ...p } });
      ctx.tracker.on('upsert', onUpsert);
      ctx.tracker.on('delete', onDelete);
      ctx.tracker.on('ports', onPorts);
      return () => {
        ctx.tracker.off('upsert', onUpsert);
        ctx.tracker.off('delete', onDelete);
        ctx.tracker.off('ports', onPorts);
        ctx.tracker.removeSubscriber();
      };
    });
  }),
  kill: t.procedure.input(z.object({ process_id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.tracker.kill(input.process_id);
    return { ok: true };
  }),
}),
```

Also export `type ProcessDelta = Extract<Delta, { op: \`process_${string}\` }>` for client use.

Add `tracker: ProcessTracker` to the tRPC Context type.

- [ ] **Step 4: Wire up in `server/src/index.ts`**

Where the server is constructed and Context is built:

```typescript
import { ProcessTracker } from './processes/index.js';
import { runStartupDiscovery } from './processes/discovery.js';
import { tailLines } from './hookSink.js'; // wherever hook records get routed today

const tracker = new ProcessTracker();
tracker.start();
await runStartupDiscovery(tracker);
```

In the existing hook record sink (look for where `HookEventSchema.parse(...)` is called and routed to `SessionStore`), add a branch:

```typescript
if (rec.kind === 'session_pid' || rec.kind === 'bash_intent' || rec.kind === 'session_end' || rec.kind === 'stop') {
  tracker.handleHookRecord(rec);
}
```

Pass `tracker` into the tRPC context factory.

- [ ] **Step 5: Write integration test**

`server/src/processes/integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ProcessTracker } from './index.js';

describe('tracker → events end-to-end', () => {
  it('emits upsert then delete', async () => {
    let phase = 0;
    const t = new ProcessTracker({
      listProcesses: async () => phase === 0 ? [
        { pid: 50, ppid: 1, start_ts: 0, comm: 'claude', command: 'claude' },
        { pid: 100, ppid: 50, start_ts: 0, comm: 'node', command: 'node /p/node_modules/vite/bin/vite.js' },
      ] : [{ pid: 50, ppid: 1, start_ts: 0, comm: 'claude', command: 'claude' }],
      listListeningPorts: async () => [],
      now: () => phase === 0 ? 5 : 100 + phase,
    });
    const events: any[] = [];
    t.on('upsert', r => events.push(['up', r.pid]));
    t.on('delete', id => events.push(['del', id]));
    t.handleHookRecord({ kind: 'session_pid', session_id: 's1', pid: 50, ppid: 1, cwd: '/p', start_ts: 0, ts: 0 });
    await t.tickOnce(); // upsert
    phase = 1; await t.tickOnce(); // missing #1
    phase = 2; await t.tickOnce(); // missing #2 → delete
    expect(events.find(([k]) => k === 'up')).toBeDefined();
    expect(events.find(([k]) => k === 'del')).toBeDefined();
  });
});
```

- [ ] **Step 6: Run all server tests**

```
cd server && npx vitest run
```

- [ ] **Step 7: Commit**

```
git add server/src/session.ts server/src/trpc.ts server/src/index.ts server/src/processes/integration.test.ts
git commit -m "server: wire ProcessTracker into Delta union + tRPC + bootstrap"
```

---

## Task 12: Client reducer + delta plumbing

**Files:**
- Modify: `client/src/useDeltaStream.ts`
- Create: `client/src/useProcesses.ts`
- Create: `client/src/useProcesses.test.ts`

A separate tRPC subscription (`trpc.processes.subscribe`) feeds a dedicated `useProcesses` store. Keeps it cleanly separable from the panel-stream reducer.

- [ ] **Step 1: Failing test**

`client/src/useProcesses.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { processesReducer, initialProcessesState } from './useProcesses.js';

const baseRow = (over: any = {}) => ({
  process_id: 'p1', host: 'local', pid: 100, ppid: 1, start_ts: 0,
  command: 'node x', cwd: '/p', session_id: 's1',
  hook_command: null, run_in_background: false,
  provenance: 'observed', runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path',
  framework: null, framework_version: null,
  ports: [], ended_ts: null, ended_reason: null, uptime_s: 5,
  ...over,
});

describe('processesReducer', () => {
  it('snapshot replaces state', () => {
    const s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [baseRow()] });
    expect(s.rows.size).toBe(1);
  });
  it('upsert adds/updates', () => {
    let s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [] });
    s = processesReducer(s, { type: 'delta', delta: { op: 'process_upsert', process: baseRow() } });
    expect(s.rows.get('p1')?.runtime).toBe('node');
  });
  it('delete removes', () => {
    let s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [baseRow()] });
    s = processesReducer(s, { type: 'delta', delta: { op: 'process_delete', process_id: 'p1' } });
    expect(s.rows.size).toBe(0);
  });
  it('ports update merges', () => {
    let s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [baseRow()] });
    s = processesReducer(s, { type: 'delta', delta: { op: 'process_ports', process_id: 'p1', ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }] } });
    expect(s.rows.get('p1')?.ports[0].port).toBe(5173);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```
cd client && npx vitest run src/useProcesses.test.ts
```

- [ ] **Step 3: Implement**

`client/src/useProcesses.ts`:

```typescript
import { useEffect, useReducer } from 'react';
import { trpc } from './trpc.js';

export type ProcessRow = {
  process_id: string; host: 'local';
  pid: number; ppid: number; start_ts: number;
  command: string; cwd: string | null;
  session_id: string | null;
  hook_command: string | null; run_in_background: boolean;
  provenance: 'hooked' | 'observed' | 'heuristic' | 'discovered';
  runtime: string | null; runtime_version: string | null; runtime_source: string | null;
  framework: string | null; framework_version: string | null;
  ports: Array<{ proto: 'TCP'; addr: string; port: number }>;
  ended_ts: number | null; ended_reason: string | null;
  uptime_s: number;
};

export type ProcessDelta =
  | { op: 'process_upsert'; process: ProcessRow }
  | { op: 'process_delete'; process_id: string }
  | { op: 'process_ports'; process_id: string; ports: ProcessRow['ports'] };

type State = { rows: Map<string, ProcessRow> };
type Action =
  | { type: 'snapshot'; rows: ProcessRow[] }
  | { type: 'delta'; delta: ProcessDelta };

export const initialProcessesState: State = { rows: new Map() };

export function processesReducer(state: State, action: Action): State {
  if (action.type === 'snapshot') {
    const m = new Map<string, ProcessRow>();
    for (const r of action.rows) m.set(r.process_id, r);
    return { rows: m };
  }
  const m = new Map(state.rows);
  const d = action.delta;
  if (d.op === 'process_upsert') m.set(d.process.process_id, d.process);
  else if (d.op === 'process_delete') m.delete(d.process_id);
  else if (d.op === 'process_ports') {
    const cur = m.get(d.process_id);
    if (cur) m.set(d.process_id, { ...cur, ports: d.ports });
  }
  return { rows: m };
}

export function useProcesses() {
  const [state, dispatch] = useReducer(processesReducer, initialProcessesState);
  useEffect(() => {
    const sub = trpc.processes.subscribe.subscribe(undefined, {
      onData(msg: any) {
        if (msg.kind === 'snapshot') dispatch({ type: 'snapshot', rows: msg.rows });
        else dispatch({ type: 'delta', delta: msg.delta });
      },
    });
    return () => sub.unsubscribe();
  }, []);
  return Array.from(state.rows.values());
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```
git add client/src/useProcesses.ts client/src/useProcesses.test.ts
git commit -m "client: useProcesses hook + reducer"
```

---

## Task 13: ProcessesPanel + ProcessRow components

**Files:**
- Create: `client/src/components/ProcessesPanel.tsx`
- Create: `client/src/components/ProcessRow.tsx`
- Create: `client/src/components/ProcessesPanel.test.tsx`

- [ ] **Step 1: Failing test**

`client/src/components/ProcessesPanel.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProcessesPanel } from './ProcessesPanel.js';

vi.mock('../useProcesses.js', () => ({
  useProcesses: () => [
    { process_id: 'p1', host: 'local', pid: 100, ppid: 1, start_ts: 0,
      command: 'node vite', cwd: '/proj', session_id: 's1',
      hook_command: 'npm run dev', run_in_background: true,
      provenance: 'hooked', runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path',
      framework: 'vite', framework_version: '5.4.2',
      ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }],
      ended_ts: null, ended_reason: null, uptime_s: 724 },
  ],
}));

describe('ProcessesPanel', () => {
  it('renders one row per process with key columns', () => {
    render(<ProcessesPanel />);
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText(/vite/)).toBeInTheDocument();
    expect(screen.getByText(/5173/)).toBeInTheDocument();
  });

  it('renders empty state when no processes', () => {
    vi.mocked(require('../useProcesses.js').useProcesses).mockReturnValueOnce([]);
    render(<ProcessesPanel />);
    expect(screen.getByText(/No processes observed yet/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```
cd client && npx vitest run src/components/ProcessesPanel.test.tsx
```

- [ ] **Step 3: Implement `ProcessRow.tsx`**

```typescript
import type { ProcessRow as Row } from '../useProcesses.js';
import { trpc } from '../trpc.js';

const PROVENANCE_DOT: Record<Row['provenance'], string> = {
  hooked: '🟢', observed: '🟡', heuristic: '🟠', discovered: '⚪',
};

function fmtUptime(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; }
  return `${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '0.0.0.0' || addr === '*';
}

export function ProcessRow({ row }: { row: Row }) {
  const kill = () => {
    if (!confirm(`Send SIGTERM to PID ${row.pid}?`)) return;
    void trpc.processes.kill.mutate({ process_id: row.process_id });
  };
  const cwdShort = row.cwd ? row.cwd.split('/').pop() : '—';

  return (
    <tr className="process-row">
      <td>{PROVENANCE_DOT[row.provenance]}</td>
      <td>{row.pid}</td>
      <td>{row.runtime ?? '—'}{row.runtime_version ? ` ${row.runtime_version}` : ''}</td>
      <td>{row.framework ?? '—'}{row.framework_version ? ` ${row.framework_version}` : ''}</td>
      <td>
        {row.ports.length === 0 ? '—' : row.ports.map(p => (
          isLoopback(p.addr)
            ? <a key={p.port} href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer">:{p.port}</a>
            : <span key={p.port}>:{p.port}</span>
        )).reduce((acc, el, i) => i === 0 ? [el] : [...acc, ' ', el], [] as any)}
      </td>
      <td>{cwdShort}</td>
      <td>{row.session_id ?? '(discovered)'}</td>
      <td>{fmtUptime(row.uptime_s)}</td>
      <td>
        <button onClick={kill} aria-label={`Kill PID ${row.pid}`}>✕</button>
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: Implement `ProcessesPanel.tsx`**

```typescript
import { useProcesses } from '../useProcesses.js';
import { ProcessRow } from './ProcessRow.js';

export function ProcessesPanel() {
  const rows = useProcesses().slice().sort((a, b) => b.uptime_s - a.uptime_s);
  return (
    <section className="processes-panel">
      <header><h2>Processes</h2></header>
      {rows.length === 0 ? (
        <p className="empty">No processes observed yet. Brainhouse watches descendants of each Claude session and listening ports on this host.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th><th>PID</th><th>Runtime</th><th>Framework</th>
              <th>Ports</th><th>cwd</th><th>Session</th><th>Uptime</th><th></th>
            </tr>
          </thead>
          <tbody>{rows.map(r => <ProcessRow key={r.process_id} row={r} />)}</tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Render in App grid**

Read `client/src/App.tsx` to locate where `ProjectWidgetCard` is rendered. Add `<ProcessesPanel />` as a sibling at the appropriate spot in the grid (likely a top-level dashboard region). If unclear, add it above the panel grid as a full-width section. Verify in the browser (Task 16).

- [ ] **Step 7: Commit**

```
git add client/src/components/ProcessesPanel.tsx client/src/components/ProcessRow.tsx client/src/components/ProcessesPanel.test.tsx client/src/App.tsx
git commit -m "client: ProcessesPanel + ProcessRow rendering the live tracker"
```

---

## Task 14: Stdout tail action

**Files:**
- Modify: `server/src/trpc.ts` (add `tailStdout` procedure)
- Modify: `client/src/components/ProcessRow.tsx` (▾ button + inline expansion)
- Modify: `server/src/processes/index.ts` (track `bash_id` per process)

The PostToolUse hook (Task 3) already records `{tool_use_id, bash_id}`. The reconciler doesn't know about these yet — add a mapping.

- [ ] **Step 1: Extend the reconciler to track bash_id**

Add to `ProcessRow`:

```typescript
bash_id: string | null;
```

Add to `Reconciler`:

```typescript
private bashIdBySession = new Map<string, string[]>(); // recent bash_ids per session

recordBashId(sessionId: string, bashId: string) {
  const arr = this.bashIdBySession.get(sessionId) ?? [];
  arr.push(bashId);
  while (arr.length > 20) arr.shift();
  this.bashIdBySession.set(sessionId, arr);
}
```

When attaching a hook intent in `tick()`, also pop the most recent `bash_id` for that session (FIFO) and assign to `row.bash_id`. (Approximate but sufficient — backgrounded calls are rare enough that ordering is reliable.)

- [ ] **Step 2: ProcessTracker.handleHookRecord — route bash_id_map**

```typescript
else if (rec.kind === 'bash_id_map') {
  this.rec.recordBashId(rec.session_id, rec.bash_id);
}
```

- [ ] **Step 3: Add tRPC `tailStdout` procedure**

This is the trickiest piece because the brainhouse server doesn't directly own the BashOutput facility — Claude Code does. v1 keeps it simple: tail the JSONL transcript for the session, find the most recent `tool_result` whose `tool_use_id` maps to this `bash_id`, return its content.

Add to `server/src/processes/index.ts`:

```typescript
import { readFileSync } from 'node:fs';

export async function tailBashOutput(sessionTranscriptPath: string, bashId: string, lines: number): Promise<string> {
  const raw = readFileSync(sessionTranscriptPath, 'utf8').split('\n').reverse();
  for (const line of raw) {
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'user' && Array.isArray(rec.message?.content)) {
        for (const c of rec.message.content) {
          if (c.type === 'tool_result' && c.tool_use_id && c.content) {
            // Match if content references the bash_id; Claude Code includes it in the body
            const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
            if (body.includes(bashId)) {
              return body.split('\n').slice(-lines).join('\n');
            }
          }
        }
      }
    } catch {}
  }
  return '';
}
```

Wire into trpc:

```typescript
tailStdout: t.procedure
  .input(z.object({ process_id: z.string(), lines: z.number().default(40) }))
  .query(async ({ ctx, input }) => {
    const row = ctx.tracker.snapshot().find(r => r.process_id === input.process_id);
    if (!row?.bash_id || !row.session_id) return { content: '' };
    const transcriptPath = ctx.store.getTranscriptPath(row.session_id);
    if (!transcriptPath) return { content: '' };
    const content = await tailBashOutput(transcriptPath, row.bash_id, input.lines);
    return { content };
  }),
```

(If `getTranscriptPath` doesn't exist on the session store, add a method that returns the path used by the parser for that session.)

- [ ] **Step 4: Client — expandable tail row**

In `ProcessRow.tsx`, add state and a ▾ button (only when `row.run_in_background`):

```typescript
import { useState } from 'react';

// inside ProcessRow:
const [tail, setTail] = useState<string | null>(null);
const fetchTail = async () => {
  const r = await trpc.processes.tailStdout.query({ process_id: row.process_id });
  setTail(r.content || '(no output)');
};

// Add button:
{row.run_in_background && (
  <button onClick={() => tail === null ? fetchTail() : setTail(null)}>▾</button>
)}

// After the row, render expansion (use a second <tr>):
{tail !== null && (
  <tr className="process-tail">
    <td colSpan={9}><pre>{tail}</pre></td>
  </tr>
)}
```

(Adjust JSX so ProcessRow returns a Fragment containing both `<tr>`s when expanded.)

- [ ] **Step 5: Tests**

Add to `ProcessesPanel.test.tsx`:

```typescript
it('hides tail button for foreground processes', () => {
  // ... mock with run_in_background: false
  // ...
  expect(screen.queryByText('▾')).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Run all tests**

```
cd /Users/mike/src/brainhouse && npm test
```

- [ ] **Step 7: Commit**

```
git add server/src/processes/index.ts server/src/processes/reconciler.ts server/src/trpc.ts client/src/components/ProcessRow.tsx client/src/components/ProcessesPanel.test.tsx
git commit -m "feat: stdout tail action for backgrounded processes"
```

---

## Task 15: Register hooks in installer

**Files:**
- Modify: `bin/init.js`
- Modify: `bin/init.test.js` (if it exists; otherwise add a small new test)

The installer's `hookRegistry()` returns `{role, event, command}` entries. Add three.

- [ ] **Step 1: Read current registry**

```
sed -n '36,61p' /Users/mike/src/brainhouse/bin/init.js
```

- [ ] **Step 2: Failing test (if test file exists, otherwise inline manual check)**

Add to `bin/init.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { hookRegistry } from './init.js'; // verify this is exported; if not, refactor minimally

describe('hookRegistry', () => {
  it('includes the three process-tracking hooks', () => {
    const reg = hookRegistry('/x/hooks');
    expect(reg.find(r => r.event === 'SessionStart' && /session-start-procs/.test(r.command))).toBeDefined();
    expect(reg.find(r => r.event === 'PreToolUse' && /pre-tool-use-bash/.test(r.command))).toBeDefined();
    expect(reg.find(r => r.event === 'PostToolUse' && /post-tool-use-bash/.test(r.command))).toBeDefined();
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Add entries to `hookRegistry()` in `bin/init.js`**

```javascript
{ role: 'procs-session-start', event: 'SessionStart',
  command: `node "${join(hooksDir, 'session-start-procs.mjs')}"` },
{ role: 'procs-pre-bash', event: 'PreToolUse',
  command: `node "${join(hooksDir, 'pre-tool-use-bash.mjs')}"`, matcher: 'Bash' },
{ role: 'procs-post-bash', event: 'PostToolUse',
  command: `node "${join(hooksDir, 'post-tool-use-bash.mjs')}"`, matcher: 'Bash' },
```

If the existing `addBrainhouse` function doesn't currently pass `matcher` through, update it to: `{ matcher: e.matcher ?? '.*', hooks: [{ type: 'command', command: e.command }] }`.

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Dry-run the installer**

```
node bin/init.js --dry-run
```

Expected: shows the three new entries being added under SessionStart / PreToolUse / PostToolUse.

- [ ] **Step 7: Commit**

```
git add bin/init.js bin/init.test.js
git commit -m "init: register process-tracking hooks"
```

---

## Task 16: End-to-end smoke test

**Files:** none new; this is a manual verification step.

- [ ] **Step 1: Install hooks**

```
node bin/init.js
```

Verify with: `grep -c brainhouse ~/.claude/settings.json` — should include the new entries.

- [ ] **Step 2: Build and start the server + client**

```
npm run build && npm run dev
```

Wait for both server and client to report ready.

- [ ] **Step 3: Open the brainhouse UI**

Open the dev URL (typically http://localhost:5173 or the configured port). Verify the `Processes` panel renders. With no Claude sessions active, it should show only `discovered` rows for already-listening ports on your machine (e.g. ControlCenter, postgres, etc.).

- [ ] **Step 4: Start a Claude Code session in a project**

In a separate terminal:

```
cd ~/some-vite-project && claude
```

Inside that session, ask: "Start the dev server in the background." Claude should run `npm run dev` with `run_in_background=true`.

Within 1–2s of the server starting, verify in the brainhouse UI:
- A 🟢 row appears with framework=vite, runtime=node, the correct port, your session's title
- Clicking the port link opens `http://localhost:5173`
- The ▾ button is visible (run_in_background=true) and expands to show recent stdout

- [ ] **Step 5: Kill from the UI**

Click ✕ → confirm. Within ~5s the row should disappear (post 3s SIGTERM grace + 2-tick absence).

- [ ] **Step 6: Verify zombie detection**

End the Claude session (Ctrl-D). Start another Claude session and have it spawn another dev server. End that session without killing the server. The brainhouse UI should still show the orphan process (since the OS process is still alive). Killing it from the UI should succeed.

- [ ] **Step 7: Commit any small fixes encountered during smoke**

```
git add -p
git commit -m "fix: smoke-test polish for process panel"
```

---

## Self-review notes (verification this plan executed against the spec)

- **Goals coverage:** find zombies (Task 16 step 6), port awareness (Task 7 + Task 13 ports column), per-session attribution (Task 8 reconciler `session_id`), global view (Task 13 ProcessesPanel) — all present.
- **Provenance tiers:** `hooked` / `observed` / `heuristic` / `discovered` all implemented (Task 8) and surfaced as dot colors (Task 13).
- **Runtime + framework detection:** Tasks 6, 7.
- **Capture pipeline:** session-pid hook (1), bash-intent labeller (2), tree walker + intent matcher (8), port sweeper (9), startup sweep (10), death paths (8 two-tick + 14 kill mutation).
- **Signal-strong filter:** Task 8 reconciler enforces `run_in_background || uptime≥3s || ports>0` before emitting upserts.
- **PID recycling:** Task 8 reconciler test covers it.
- **Port URL safety:** loopback-only links — Task 13 `ProcessRow.isLoopback`.
- **Kill safety:** PID ≤ 1000 rejected — Task 5 `signalProcess`.
- **Runtime probe safety:** Probe is referenced in Task 6 spec but only path+argv detection is implemented in v1. Spec note: the probe (with timeout, allowlist, sandboxed env) is deferred — path + argv already cover the version-managed common case, and adding the probe later doesn't change the schema. **Implementer note:** if the smoke test in Task 16 surfaces a runtime that path-detection misses, add `runtimeProbe()` to `runtime.ts` then.
- **Remote-host future:** host-isolation lives in `native.ts` (Task 5).

## Deferred (out of scope for this plan)

- kqueue `NOTE_EXIT` for instant death detection (needs `ffi-napi`).
- `<exe> --version` probe (path + argv covers the common case; add when smoke surfaces a gap).
- Remote-host sidecar (`brainhouse-procd`).
- Resource graphs (CPU/RSS over time).
