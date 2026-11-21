/**
 * What a per-prompt hook last told each session, so it speaks only when that changes. Everything
 * a hook injects stays in context and is re-read by every later call, so repeating an unchanged
 * reminder each turn is pure cost. SessionStart forgets a session (compaction or a resume drops
 * or dates the earlier copy), so the next prompt says it again.
 *
 * One file per hook under ~/.brainhouse/hook-state, capped at MAX_SESSIONS entries.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SESSIONS = 200;

export const PROCS_REMINDER = 'session-procs-reminder';

function stateFile(hookName) {
  const dir = process.env.BRAINHOUSE_HOOK_STATE_DIR
    ? path.resolve(process.env.BRAINHOUSE_HOOK_STATE_DIR)
    : path.join(os.homedir(), '.brainhouse', 'hook-state');
  return path.join(dir, `${hookName}.json`);
}

function load(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(file, state) {
  const entries = Object.entries(state)
    .sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0))
    .slice(0, MAX_SESSIONS);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    renameSync(tmp, file);
  } catch {
    /* never block Claude on bookkeeping */
  }
}

/** What `hookName` last said to `sessionId`; empty when it has said nothing since SessionStart. */
export function lastSaid(hookName, sessionId) {
  return load(stateFile(hookName))[sessionId]?.text ?? '';
}

/** Record `text` (empty for "said nothing") as what `hookName` last said to `sessionId`. */
export function rememberSaid(hookName, sessionId, text) {
  const file = stateFile(hookName);
  const state = load(file);
  if (!text && !(sessionId in state)) return;
  state[sessionId] = { text, ts: Date.now() };
  save(file, state);
}

export function forgetSaid(hookName, sessionId) {
  const file = stateFile(hookName);
  const state = load(file);
  if (!(sessionId in state)) return;
  delete state[sessionId];
  save(file, state);
}
