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

// This hook is spawned by the Claude Code process, so it inherits the
// launching terminal's ITERM_SESSION_ID (`w<win>t<tab>p<pane>:<GUID>`). We
// keep just the GUID, which is what iTerm2's AppleScript `id of session`
// matches — letting the UI reveal the owning pane later. Null outside iTerm2.
function itermGuid() {
  const raw = process.env.ITERM_SESSION_ID;
  if (!raw) return null;
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
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
  claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
  iterm_session_id: itermGuid(),
};

try {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
} catch { /* never block Claude */ }
process.exit(0);
