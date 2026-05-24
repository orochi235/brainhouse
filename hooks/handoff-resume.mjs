#!/usr/bin/env node
/**
 * SessionStart hook (matcher: "clear") — seeds the fresh session with a
 * handoff written by the previous session before it cleared.
 *
 * Convention: the outgoing session writes
 *   ~/.claude-pw/handoff/<cwd-slug>.json
 * with shape { initialUserMessage?: string, additionalContext?: string }.
 * cwd-slug is the cwd with `/` replaced by `-` (matches the projects/
 * directory naming).
 *
 * On /clear this hook reads that file, emits its contents as the
 * SessionStart hook output, and deletes the file (one-shot).
 */
import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function cwdSlug(cwd) {
  return cwd.replace(/\//g, '-');
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {}
  const cwd = payload.cwd || process.cwd();
  const file = path.join(homedir(), '.claude-pw', 'handoff', `${cwdSlug(cwd)}.json`);

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return;
  } // no handoff — silent

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    await unlink(file).catch(() => {});
    return;
  }

  const out = { hookEventName: 'SessionStart' };
  if (typeof data.additionalContext === 'string' && data.additionalContext) {
    out.additionalContext = data.additionalContext;
  }
  if (typeof data.initialUserMessage === 'string' && data.initialUserMessage) {
    out.initialUserMessage = data.initialUserMessage;
  }

  await unlink(file).catch(() => {});
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));

  const sessionId = payload?.session_id ?? payload?.sessionId;
  const injectedTokens =
    estimateTokens(out.additionalContext ?? '') + estimateTokens(out.initialUserMessage ?? '');
  await recordHookOverhead({ sessionId, hookName: 'handoff-resume', tokens: injectedTokens });
}

main().catch(() => process.exit(0));
