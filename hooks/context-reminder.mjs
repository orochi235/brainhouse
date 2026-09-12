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
 * The threshold is a fraction of the session's context window, not a flat
 * number: 250k is a quarter of a 1M window and more than a 200k one, so a
 * fixed figure either nags a large-window session from its first hour or
 * never fires at all on a small one.
 *
 * The window is inferred from the largest context the session has actually
 * carried, because nothing records it. The model id is no help — a 1M
 * session and a 200k one both write `claude-opus-5`, and the `[1m]` suffix
 * appears nowhere in the transcript. A request that carried 486k tokens
 * proves the window is not 200k, which is the only evidence there is. The
 * cost of inferring is one spurious warning before a long-context session
 * first crosses the small window; the cost of guessing from the model id
 * was a hook reporting 242% full.
 *
 * Env:
 *   BRAINHOUSE_CONTEXT_FRACTION   how full before warning (default 0.7)
 *   BRAINHOUSE_CONTEXT_THRESHOLD  absolute override, skips the fraction
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

/** Warn once the window is this full. Late enough to be worth acting on. */
const DEFAULT_FRACTION = 0.7;
/** The windows worth telling apart, smallest first. */
const WINDOWS = [200_000, 1_000_000];
const DEFAULT_WINDOW = WINDOWS[0];

/** The smallest window that could have held what this session has carried. */
function windowFor(peak) {
  return WINDOWS.find((w) => peak <= w) ?? WINDOWS[WINDOWS.length - 1];
}
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

  const measured = await estimateContextTokens(transcriptPath);
  if (measured === null) return;
  const { tokens, peak } = measured;
  const window = windowFor(peak);
  const fraction = Number(process.env.BRAINHOUSE_CONTEXT_FRACTION) || DEFAULT_FRACTION;
  const threshold =
    Number(process.env.BRAINHOUSE_CONTEXT_THRESHOLD) || Math.round(window * fraction);
  if (tokens < threshold) return;

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
    `⚠️ Context is ${Math.round((tokens / window) * 100)}% full ` +
    `(~${formatThousands(tokens)} of a ${formatThousands(window)} window; warns at ${formatThousands(threshold)}). ` +
    'If this prompt is starting a substantial new chunk of work (a multi-step task, a new feature, a fresh plan) ' +
    'AND prior conversation context isn\'t needed, suggest the user run `/clear` (or `/branch` to fork). ' +
    'For trivial questions, quick follow-ups, status checks, or anything continuing in-flight work, ' +
    'just answer normally — do NOT mention the suggestion. Save it for the moments where a fresh session would actually help.';

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
 * The context the last assistant turn carried, and the largest any turn in
 * the session has carried. The peak is what says how big the window is.
 * Returns null if no usage record found.
 */
async function estimateContextTokens(transcriptPath) {
  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  let tokens = null;
  let peak = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
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
    tokens = input + cacheCreate + cacheRead;
    if (tokens > peak) peak = tokens;
  }
  return tokens === null ? null : { tokens, peak };
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
