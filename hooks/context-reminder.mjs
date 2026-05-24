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
 * Env:
 *   BRAINHOUSE_CONTEXT_THRESHOLD  override token threshold (default 150000)
 *   BRAINHOUSE_HOOK_DEBUG         if set, append parse errors to
 *                                 ~/.brainhouse/dispatcher.log
 *
 * Output: JSON to stdout per the UserPromptSubmit hook contract; always
 * exits 0 (never blocks the prompt). Silent when under threshold.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

const DEFAULT_THRESHOLD = 150_000;

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
