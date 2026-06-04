#!/usr/bin/env node
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventsDir } from './lib/overhead.mjs';

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

try {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
} catch { /* never block Claude */ }
process.exit(0);
