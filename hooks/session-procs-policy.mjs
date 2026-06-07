#!/usr/bin/env node
/**
 * brainhouse SessionStart hook: injects a one-time policy reminder
 * telling Claude that the session owns dev server process lifecycle.
 *
 * Pairs with the per-turn `session-procs-reminder` UserPromptSubmit
 * hook (which lists *what's running*); this hook sets *the rule* once
 * at session start, so the policy doesn't have to be re-emitted on
 * every turn.
 *
 * Fires only on `source: 'startup'`. Resume/clear/compact already have
 * the policy in their carried context, or are mid-task continuations
 * where re-injecting would be noise.
 */
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

const MESSAGE =
  'Dev server policy (brainhouse): you are responsible for managing dev server processes ' +
  '(npm run dev, vite, ladle, etc.) for projects you touch this session. ' +
  'When you need one running, launch it in the background — Bash with `run_in_background: true` — ' +
  'so it is trackable by the processes panel, frees your turn, and can be killed cleanly. ' +
  'A per-turn reminder will list what is already running; reuse existing servers before spawning duplicates, ' +
  'and tear down anything you started that the user no longer needs.';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const source = payload?.source;
  if (source !== 'startup') return;

  const sessionId = payload?.session_id ?? payload?.sessionId;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: MESSAGE,
      },
    })}\n`,
  );

  await recordHookOverhead({
    sessionId,
    hookName: 'session-procs-policy',
    tokens: estimateTokens(MESSAGE),
  });
}

main().catch(async (err) => {
  if (!process.env.BRAINHOUSE_HOOK_DEBUG) return;
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const logPath = path.join(os.homedir(), '.brainhouse', 'dispatcher.log');
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${new Date().toISOString()} session-procs-policy: ${err?.stack ?? err}\n`,
      'utf8',
    );
  } catch {
    /* nothing to do */
  }
});
