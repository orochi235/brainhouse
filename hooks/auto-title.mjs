#!/usr/bin/env node
/**
 * brainhouse Stop hook — proposes a panel title via `claude -p` running on
 * the user's own CLI auth.
 *
 * Wire-up: installed alongside the dispatcher in Claude Code's Stop hooks
 * (see bin/init.js). Gated by `experimental.autoTitle` in prefs.json.
 *
 * Flow (silent unless gated on, exits 0 unconditionally so Claude Code
 * never blocks on us):
 *   1. Read prefs.json — bail if display.autoTitle is off.
 *   2. Read transcript JSONL — bail if not enough turns yet.
 *   3. Scan for a `custom-title` meta record to decide placeholder vs. set.
 *   4. Build a compact slice (first user prompt + last two turns) and
 *      shell out to `claude -p` with a "KEEP or rename" prompt.
 *   5. If the model returns a new title, append an auto_title event to
 *      ~/.brainhouse/events/<session_id>.jsonl. The server is the final
 *      arbiter — it dedupes against the current panel title.
 *
 * Env:
 *   BRAINHOUSE_AUTOTITLE_DEBUG  log decisions to ~/.brainhouse/auto-title.log
 *   BRAINHOUSE_AUTOTITLE_MODEL  override model passed to `claude -p`
 *   BRAINHOUSE_PREFS            override prefs.json path
 *   BRAINHOUSE_EVENTS_DIR       override sidecar events dir
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PLACEHOLDER_TURN_THRESHOLD = 2;
const RECHECK_EVERY_N_TURNS = 20;
const TITLE_MAX_WORDS = 14;
const TITLE_MAX_CHARS = 80;
const FIRST_PROMPT_CHARS = 500;
const TURN_CHARS = 500;
const MODEL_TIMEOUT_MS = 25_000;

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
  if (!sessionId || !transcriptPath) return;

  const prefs = await readPrefs();
  // Migrated from `experimental.autoTitle`. Read the new location first;
  // fall back to the old one for prefs.json files that haven't been
  // resaved since the move. Default is on.
  const autoTitle = prefs?.display?.autoTitle ?? prefs?.experimental?.autoTitle ?? true;
  if (!autoTitle) {
    return debug('autoTitle disabled');
  }

  let lines;
  try {
    const raw = await readFile(transcriptPath, 'utf8');
    lines = raw.split('\n').filter((l) => l.trim().length > 0);
  } catch (err) {
    return debug(`read transcript failed: ${err?.message ?? err}`);
  }

  const turns = extractTurns(lines);
  if (turns.user.length < 1 || turns.assistant.length < 1) {
    return debug(`not enough turns (u=${turns.user.length} a=${turns.assistant.length})`);
  }

  const hasCustomTitle = hasCustomTitleMeta(lines);
  const turnCount = turns.user.length;
  if (!shouldFire(hasCustomTitle, turnCount)) {
    return debug(`skip: hasCustomTitle=${hasCustomTitle} turns=${turnCount}`);
  }

  const slice = buildSlice(turns);
  const prompt = buildPrompt(hasCustomTitle ? '(unknown — ask server)' : '(placeholder)', slice);

  let modelOutput;
  try {
    modelOutput = await runClaude(prompt);
  } catch (err) {
    return debug(`claude -p failed: ${err?.message ?? err}`);
  }
  const proposed = parseTitle(modelOutput);
  if (!proposed) return debug(`model returned KEEP or empty: ${JSON.stringify(modelOutput)}`);

  await writeEvent(sessionId, proposed);
  debug(`proposed title: ${JSON.stringify(proposed)}`);
}

function shouldFire(hasCustomTitle, turnCount) {
  if (!hasCustomTitle) return turnCount >= PLACEHOLDER_TURN_THRESHOLD;
  // Periodic drift check: re-evaluate every Nth turn even when a title is
  // set. The model self-vetoes with KEEP if it still fits, and the server
  // dedupes against the current title regardless.
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

function buildSlice({ user, assistant }) {
  const first = trunc(user[0] ?? '', FIRST_PROMPT_CHARS);
  // Last two turns (paired). If asymmetric, pair what we have.
  const lastN = 2;
  const u = user.slice(-lastN);
  const a = assistant.slice(-lastN);
  const recent = [];
  const start = Math.max(0, Math.max(u.length, a.length) - lastN);
  for (let i = start; i < Math.max(u.length, a.length); i++) {
    if (u[i]) recent.push(`USER: ${trunc(u[i], TURN_CHARS)}`);
    if (a[i]) recent.push(`ASSISTANT: ${trunc(a[i], TURN_CHARS)}`);
  }
  return { first, recent: recent.join('\n\n') };
}

function trunc(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function buildPrompt(currentTitle, slice) {
  return `You are titling a Claude Code session shown in a small side panel.
Current title: "${currentTitle}"

Reply with ONE line and nothing else:
  KEEP           — if the current title still accurately summarizes the work.
  <new title>    — otherwise. Max ${TITLE_MAX_WORDS} words. No quotes. Sentence case.
                   Describe the work, not the tool ("Wire auto-titling hook",
                   not "Helping the user with auto-titling").

[original ask]
${slice.first}

[recent turns]
${slice.recent}
`;
}

function parseTitle(modelOutput) {
  const lines = modelOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Sometimes the CLI prefaces with status text; take the last non-empty line.
  const candidate = lines[lines.length - 1] ?? '';
  if (!candidate) return null;
  if (/^keep$/i.test(candidate)) return null;
  const cleaned = candidate.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/);
  if (words.length > TITLE_MAX_WORDS) return null;
  return cleaned.length > TITLE_MAX_CHARS ? `${cleaned.slice(0, TITLE_MAX_CHARS - 1)}…` : cleaned;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const model = process.env.BRAINHOUSE_AUTOTITLE_MODEL ?? 'haiku';
    const args = ['-p', '--model', model];
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(reject, new Error(`timeout after ${MODEL_TIMEOUT_MS}ms`));
    }, MODEL_TIMEOUT_MS);
    proc.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    proc.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      finish(reject, e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(reject, new Error(`exit ${code}: ${err.trim()}`));
      finish(resolve, out.trim());
    });
    proc.stdin.end(prompt);
  });
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
      const raw = await readFile(p, 'utf8');
      return JSON.parse(raw);
    } catch {
      /* try next */
    }
  }
  return null;
}

async function writeEvent(sessionId, title) {
  const dir = process.env.BRAINHOUSE_EVENTS_DIR
    ? path.resolve(process.env.BRAINHOUSE_EVENTS_DIR)
    : path.join(os.homedir(), '.brainhouse', 'events');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const event = {
    kind: 'auto_title',
    session_id: sessionId,
    title,
    ts: Date.now() / 1000,
  };
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

async function debug(msg) {
  if (!process.env.BRAINHOUSE_AUTOTITLE_DEBUG) return;
  try {
    const file = path.join(os.homedir(), '.brainhouse', 'auto-title.log');
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    /* nothing to do */
  }
}

// Exports for tests. Top-level run only happens when invoked as the entry
// point; importing the module pulls in the pure helpers without firing
// `main()`.
export { buildPrompt, buildSlice, extractTurns, hasCustomTitleMeta, parseTitle, shouldFire };

const isEntryPoint =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  main().catch(async (err) => {
    await debug(`fatal: ${err?.stack ?? err}`);
  });
}
