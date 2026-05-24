#!/usr/bin/env node
/**
 * brainhouse UserPromptSubmit hook: injects a `consider /clear` nudge into
 * Claude's view of the prompt when the current session's context size has
 * crossed a threshold.
 *
 * Tokens-per-turn aren't visible to hooks directly — we estimate by
 * scanning the transcript JSONL for the most recent assistant message and
 * summing `usage.input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`. That's the prompt-side context that turn
 * actually consumed; it's the closest proxy for "how full is the window."
 *
 * Wire-up: install in ~/.claude/settings.json (or ~/.claude-pw/) under
 *   hooks.UserPromptSubmit:
 *     {
 *       "matcher": ".*",
 *       "hooks": [{ "type": "command",
 *                   "command": "node /Users/.../hooks/context-reminder.mjs" }]
 *     }
 *
 * Throttling: once a session first crosses the threshold we warn, then
 * stay silent for `WARN_COOLDOWN_MS` (15 min) before warning again, even
 * if context keeps growing. State lives in
 * `~/.brainhouse/context-reminder-state.json` keyed by session_id.
 *
 * Env:
 *   BRAINHOUSE_CONTEXT_THRESHOLD  override token threshold (default 150000)
 *   BRAINHOUSE_HOOK_DEBUG         if set, append parse errors to
 *                                 ~/.brainhouse/dispatcher.log
 *
 * Output: JSON to stdout per the UserPromptSubmit hook contract; always
 * exits 0 (never blocks the prompt). Silent when under threshold OR when
 * the last warning fired within the cooldown window.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

const DEFAULT_THRESHOLD = 150_000;
const WARN_COOLDOWN_MS = 15 * 60 * 1000;
const STATE_PATH = path.join(os.homedir(), '.brainhouse', 'context-reminder-state.json');
/** Drop session entries older than this on each write so the file doesn't
 * grow unbounded over time. */
const STATE_PRUNE_MS = 24 * 60 * 60 * 1000;

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
  const transcriptPath = payload?.transcript_path ?? payload?.transcriptPath;
  if (typeof transcriptPath !== 'string') return;
  const sessionId = payload?.session_id ?? payload?.sessionId;

  const threshold = Number(process.env.BRAINHOUSE_CONTEXT_THRESHOLD) || DEFAULT_THRESHOLD;
  const tokens = await estimateContextTokens(transcriptPath);
  if (tokens === null || tokens < threshold) return;

  // Throttle: don't re-nag within the cooldown window. First crossing
  // always warns; subsequent ones only after WARN_COOLDOWN_MS elapses.
  const now = Date.now();
  const state = await loadState();
  const last = sessionId ? state[sessionId] : undefined;
  if (typeof last === 'number' && now - last < WARN_COOLDOWN_MS) return;
  if (sessionId) {
    state[sessionId] = now;
    await saveState(pruneState(state, now));
  }

  const message =
    `⚠️ Context is high (~${formatThousands(tokens)} tokens, threshold ${formatThousands(threshold)}). ` +
    'Before answering, ask whether this prompt actually needs prior conversation context. ' +
    'If not, suggest the user run `/clear` (or `/branch` to fork) and start the task fresh.';

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: message,
      },
    })}\n`,
  );
  await recordHookOverhead({
    sessionId,
    hookName: 'context-reminder',
    tokens: estimateTokens(message),
  });
}

/**
 * Scan the JSONL backwards looking for the most recent assistant message
 * with a `usage` block; return the sum of its three input-token fields.
 * Returns null if no usage record found.
 */
async function estimateContextTokens(transcriptPath) {
  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'assistant') continue;
    const usage = rec?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const input = Number(usage.input_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    return input + cacheCreate + cacheRead;
  }
  return null;
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* missing or malformed — start fresh */
  }
  return {};
}

async function saveState(state) {
  try {
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state), 'utf8');
  } catch {
    /* nothing to do — throttling is best-effort */
  }
}

function pruneState(state, now) {
  const out = {};
  for (const [id, ts] of Object.entries(state)) {
    if (typeof ts === 'number' && now - ts < STATE_PRUNE_MS) out[id] = ts;
  }
  return out;
}

function formatThousands(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

main().catch(async (err) => {
  if (!process.env.BRAINHOUSE_HOOK_DEBUG) return;
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const logPath = path.join(os.homedir(), '.brainhouse', 'dispatcher.log');
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${new Date().toISOString()} context-reminder: ${err?.stack ?? err}\n`,
      'utf8',
    );
  } catch {
    /* nothing to do */
  }
});
