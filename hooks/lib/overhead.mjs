/**
 * Shared accounting helper for brainhouse hooks that inject text into
 * Claude Code's context (UserPromptSubmit `additionalContext`,
 * SessionStart `additionalContext` / `initialUserMessage`).
 *
 * Each call appends one `hook_overhead` record to
 *   ~/.brainhouse/events/<sessionId>.jsonl
 * which the brainhouse server tails and accumulates onto the panel's
 * `hook_overhead_tokens` counter.
 *
 * Token estimate is the conventional ~4-chars-per-token proxy. That's
 * coarse but it matches the order of magnitude reported by the model's
 * own usage metrics for short prose; close enough for a "how much are
 * we costing you" indicator.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TOKEN_CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN);
}

export function eventsDir() {
  return process.env.BRAINHOUSE_EVENTS_DIR
    ? path.resolve(process.env.BRAINHOUSE_EVENTS_DIR)
    : path.join(os.homedir(), '.brainhouse', 'events');
}

/** Record `tokens` worth of context-injection by `hookName` against `sessionId`.
 * Returns silently on any error so a hook never blocks Claude Code on accounting. */
export async function recordHookOverhead({ sessionId, hookName, tokens }) {
  if (!sessionId || !Number.isFinite(tokens) || tokens <= 0) return;
  const event = {
    kind: 'hook_overhead',
    session_id: sessionId,
    hook_name: String(hookName ?? 'unknown'),
    tokens: Math.max(0, Math.floor(tokens)),
    ts: Date.now() / 1000,
  };
  try {
    const dir = eventsDir();
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    /* never block on accounting */
  }
}
