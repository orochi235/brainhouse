#!/usr/bin/env node
/**
 * brainhouse UserPromptSubmit hook — piggybacks an auto-title request onto
 * the live session's next turn. The model sees an extra instruction in
 * `additionalContext` asking it to emit `<<bh-title>>X</bh-title>>` (or
 * `<<bh-title>>KEEP</bh-title>>`) at the very end of its response. The
 * server-side parser extracts the marker and routes it through the same
 * applyAutoTitle path the older `claude -p` hook used.
 *
 * This replaces the previous Stop-hook `auto-title.mjs` that shelled out
 * to `claude -p` — that path was costing ~50k tokens per invocation due
 * to harness boot. Inline costs ~1-2 prompt-cached tokens per nth turn
 * plus ~20 output tokens to emit the marker. Auto-title is UDP-fidelity
 * by design; a missed marker just defers the title to the next eligible
 * turn.
 *
 * Gated by `display.autoTitle` in ~/.brainhouse/prefs.json (default on).
 *
 * Env:
 *   BRAINHOUSE_AUTOTITLE_DEBUG  log decisions to ~/.brainhouse/auto-title.log
 *   BRAINHOUSE_PREFS            override prefs.json path
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

const PLACEHOLDER_TURN_THRESHOLD = 2;
const RECHECK_EVERY_N_TURNS = 20;
const TITLE_MAX_WORDS = 14;

const ARTIFACT_RE = /^<(local-command-(caveat|stdout)|command-(name|message|args))>/;

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
  const sessionId = payload?.session_id ?? payload?.sessionId;
  const transcriptPath = payload?.transcript_path ?? payload?.transcriptPath;
  if (typeof transcriptPath !== 'string') return;

  const prefs = await readPrefs();
  const autoTitle = prefs?.display?.autoTitle ?? prefs?.experimental?.autoTitle ?? true;
  if (!autoTitle) return debug('autoTitle disabled');

  let lines;
  try {
    const txt = await readFile(transcriptPath, 'utf8');
    lines = txt.split('\n').filter((l) => l.trim().length > 0);
  } catch (err) {
    return debug(`read transcript failed: ${err?.message ?? err}`);
  }

  const turns = extractTurns(lines);
  const hasCustomTitle = hasCustomTitleMeta(lines);
  const turnCount = turns.user.length;
  if (!shouldFire(hasCustomTitle, turnCount)) {
    return debug(`skip: hasCustomTitle=${hasCustomTitle} turns=${turnCount}`);
  }

  const message = buildInstruction(hasCustomTitle);

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
    hookName: 'auto-title-inline',
    tokens: estimateTokens(message),
  });
  debug(`injected (turns=${turnCount} hasCustomTitle=${hasCustomTitle})`);
}

function buildInstruction(hasCustomTitle) {
  const role = hasCustomTitle
    ? 'The session already has a title. If it still fits the work, reply KEEP — otherwise propose a fresh one.'
    : 'The session needs its first real title.';
  return `[brainhouse auto-title] ${role} On the very last line of your response, AFTER everything else, emit exactly one of:
  <<bh-title>>KEEP</bh-title>>
  <<bh-title>>your concise session title</bh-title>>
Rules: max ${TITLE_MAX_WORDS} words, sentence case, no quotes, no trailing punctuation. Describe the work, not the tool ("Wire auto-titling hook", not "Helping the user with auto-titling"). The marker is stripped from the UI; it is purely a side channel.`;
}

function shouldFire(hasCustomTitle, turnCount) {
  if (!hasCustomTitle) return turnCount >= PLACEHOLDER_TURN_THRESHOLD;
  return turnCount > 0 && turnCount % RECHECK_EVERY_N_TURNS === 0;
}

function hasCustomTitleMeta(lines) {
  for (const line of lines) {
    if (!line.includes('custom-title')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.type === 'custom-title' || rec?.record_type === 'custom-title') return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function extractTurns(lines) {
  const user = [];
  const assistant = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'user' && rec?.type !== 'assistant') continue;
    if (rec.isSidechain) continue;
    const text = extractText(rec);
    if (!text) continue;
    if (rec.type === 'user' && ARTIFACT_RE.test(text.trim())) continue;
    (rec.type === 'user' ? user : assistant).push(text);
  }
  return { user, assistant };
}

function extractText(rec) {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function readPrefs() {
  const candidates = [];
  if (process.env.BRAINHOUSE_PREFS) candidates.push(path.resolve(process.env.BRAINHOUSE_PREFS));
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'brainhouse', 'prefs.json'));
  }
  candidates.push(path.join(os.homedir(), '.brainhouse', 'prefs.json'));
  for (const p of candidates) {
    try {
      const txt = await readFile(p, 'utf8');
      return JSON.parse(txt);
    } catch {
      /* try next */
    }
  }
  return null;
}

async function debug(msg) {
  if (!process.env.BRAINHOUSE_AUTOTITLE_DEBUG) return;
  try {
    const file = path.join(os.homedir(), '.brainhouse', 'auto-title.log');
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    /* nothing */
  }
}

export { buildInstruction, extractTurns, hasCustomTitleMeta, shouldFire };

const isEntryPoint =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  main().catch(async (err) => {
    await debug(`fatal: ${err?.stack ?? err}`);
  });
}
