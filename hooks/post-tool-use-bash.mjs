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
const transcriptPath = p?.transcript_path ?? p?.transcriptPath;
if (typeof transcriptPath === 'string') rec.transcript_path = transcriptPath;

try {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${p.session_id}.jsonl`), JSON.stringify(rec) + '\n');
} catch { /* never block Claude */ }
process.exit(0);
