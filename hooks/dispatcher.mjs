#!/usr/bin/env node
/**
 * brainhouse hook dispatcher.
 *
 * Installed into the user's Claude Code settings.json by `brainhouse init`.
 * One invocation per hook event. Reads the hook payload from stdin, appends
 * one normalized JSON line to ~/.brainhouse/events/<session_id>.jsonl, and
 * exits 0 — silently swallowing any error so Claude Code never blocks on us.
 *
 * Usage: node dispatcher.mjs <kind>
 *   kind ∈ {stop, subagent_stop, notification, session_end, session_start}
 *
 * Env:
 *   BRAINHOUSE_EVENTS_DIR  override sidecar directory (default ~/.brainhouse/events)
 *   BRAINHOUSE_HOOK_DEBUG  if set, write parse errors to ~/.brainhouse/dispatcher.log
 */
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VALID_KINDS = new Set([
  'stop',
  'subagent_stop',
  'notification',
  'session_end',
  'session_start',
]);

async function main() {
  const kind = process.argv[2];
  if (!kind || !VALID_KINDS.has(kind)) return; // silent no-op

  const dir = process.env.BRAINHOUSE_EVENTS_DIR
    ? path.resolve(process.env.BRAINHOUSE_EVENTS_DIR)
    : path.join(os.homedir(), '.brainhouse', 'events');

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const sessionId = payload?.session_id ?? payload?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;

  const event = {
    kind,
    session_id: sessionId,
    ts: Date.now() / 1000,
  };
  const transcriptPath = payload?.transcript_path ?? payload?.transcriptPath;
  if (typeof transcriptPath === 'string') event.transcript_path = transcriptPath;
  const message = payload?.message;
  if (typeof message === 'string') event.message = message;
  // SessionStart carries a `source` ∈ {startup, resume, clear, compact}.
  // Brainhouse uses this to decide whether a prior live panel should be
  // superseded (clear/compact) vs left alone (startup/resume).
  const source = payload?.source;
  if (typeof source === 'string') event.source = source;

  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

main().catch(async (err) => {
  if (!process.env.BRAINHOUSE_HOOK_DEBUG) return;
  try {
    const logPath = path.join(os.homedir(), '.brainhouse', 'dispatcher.log');
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${err?.stack ?? err}\n`, 'utf8');
  } catch {
    /* nothing to do */
  }
});
