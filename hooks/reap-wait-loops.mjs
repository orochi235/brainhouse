#!/usr/bin/env node
/**
 * brainhouse UserPromptSubmit + SessionStart hook: kills this `claude`
 * process's stuck background wait loops and tells the model what it killed.
 * The rules are in `lib/wait-loops.mjs`.
 *
 * Env:
 *   BRAINHOUSE_REAP_DRY_RUN  report, kill nothing
 *   BRAINHOUSE_HOOK_DEBUG    log errors to ~/.brainhouse/dispatcher.log
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';
import { forgetSaid, lastSaid, rememberSaid } from './lib/said.mjs';
import { classify, claudeAncestor, describe, parsePs } from './lib/wait-loops.mjs';

const HOOK_NAME = 'reap-wait-loops';

const LOG = path.join(os.homedir(), '.brainhouse', 'reaper.log');
const LOG_CAP = 64 * 1024;

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw || '{}');
  const sessionId = payload.session_id ?? payload.sessionId;
  const event = payload.hook_event_name ?? 'UserPromptSubmit';
  if (!sessionId) return;
  if (event === 'SessionStart') forgetSaid(HOOK_NAME, sessionId);

  const rows = parsePs(
    execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' }),
  );
  const claudePid = claudeAncestor(rows, process.ppid);
  if (!claudePid) return;

  const loops = classify(rows, { claudePid, sessionId });
  if (loops.length === 0) {
    rememberSaid(HOOK_NAME, sessionId, '');
    return;
  }

  const dry = Boolean(process.env.BRAINHOUSE_REAP_DRY_RUN);
  const reaped = [];
  for (const loop of loops.filter((l) => l.verdict === 'reap')) {
    if (!dry) {
      for (const child of rows.filter((r) => r.ppid === loop.pid)) kill(child.pid);
      if (!kill(loop.pid)) continue;
    }
    reaped.push(loop);
    log(`${dry ? 'would reap' : 'reaped'} ${describe(loop)} :: ${loop.command.slice(-300)}`);
  }
  // A suspect stays one until it is killed or wakes; name each set once, not on every prompt.
  const suspected = loops.filter((l) => l.verdict === 'suspect');
  const key = suspected.map((l) => l.pid).join(' ');
  const suspects = lastSaid(HOOK_NAME, sessionId) === key ? [] : suspected;
  rememberSaid(HOOK_NAME, sessionId, key);

  const parts = [];
  if (reaped.length) {
    parts.push(
      `${dry ? 'Would have killed' : 'Killed'} stuck background wait loops (brainhouse reaper): ` +
        `${reaped.map(describe).join('; ')}. Their task notifications will report a failure; nothing ran in them.`,
    );
  }
  if (suspects.length) {
    parts.push(
      `Background wait loops that look stuck — nothing they watch has changed in 30m: ` +
        `${suspects.map(describe).join('; ')}. Kill them by PID if they no longer have a job.`,
    );
  }
  if (!parts.length) return;
  const message = parts.join('\n');
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: message } })}\n`,
  );
  await recordHookOverhead({
    sessionId,
    hookName: HOOK_NAME,
    tokens: estimateTokens(message),
  });
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function log(line) {
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    if (statSync(LOG, { throwIfNoEntry: false })?.size > LOG_CAP) {
      const kept = readFileSync(LOG, 'utf8').slice(-LOG_CAP / 2);
      writeFileSync(LOG, kept.slice(kept.indexOf('\n') + 1));
    }
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging never blocks the prompt */
  }
}

main().catch((err) => {
  if (!process.env.BRAINHOUSE_HOOK_DEBUG) return;
  try {
    appendFileSync(
      path.join(os.homedir(), '.brainhouse', 'dispatcher.log'),
      `${new Date().toISOString()} reap-wait-loops: ${err?.stack ?? err}\n`,
    );
  } catch {
    /* nothing to do */
  }
});
