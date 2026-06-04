#!/usr/bin/env node
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventsDir } from './lib/overhead.mjs';

async function readStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function startTsNs() {
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

const rec = {
  kind: 'session_pid',
  session_id: sessionId,
  pid: process.ppid,
  ppid: -1,
  cwd: process.cwd(),
  start_ts: startTsNs(),
  ts: Date.now() / 1000,
};

try {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
} catch { /* never block Claude */ }
process.exit(0);
