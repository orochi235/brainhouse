#!/usr/bin/env node
/**
 * brainhouse UserPromptSubmit hook: surfaces live background processes
 * attributed to the active Claude session — dev servers, watchers, any
 * `run_in_background: true` Bash invocation that's still running.
 *
 * Without this, sessions routinely lose track of servers they spun up
 * minutes earlier and either spawn duplicates or forget to clean up.
 * The reminder injects a compact one-line-per-process summary as
 * additionalContext so the running model sees current state on every
 * turn at near-zero token cost.
 *
 * Talks to the brainhouse server's plain-JSON `/procs/by-session/:id`
 * endpoint. Silent when the server isn't running or no live processes
 * match — never blocks the prompt.
 *
 * Env:
 *   BRAINHOUSE_PORT       override server port (default 8765)
 *   BRAINHOUSE_HOOK_DEBUG log errors to ~/.brainhouse/dispatcher.log
 */
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

const PORT = process.env.BRAINHOUSE_PORT || '8765';
const FETCH_TIMEOUT_MS = 250;

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
  if (typeof sessionId !== 'string' || !sessionId) return;

  const rows = await fetchRows(sessionId);
  if (!rows || rows.length === 0) return;

  const lines = rows
    .map(formatRow)
    .filter(Boolean)
    .slice(0, 8); // hard cap so the reminder never balloons
  if (lines.length === 0) return;

  const message =
    `Live background processes from this session (brainhouse):\n  ${lines.join('\n  ')}\n` +
    'Reuse these where possible instead of starting fresh ones; kill any you no longer need.';

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
    hookName: 'session-procs-reminder',
    tokens: estimateTokens(message),
  });
}

async function fetchRows(sessionId) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://127.0.0.1:${PORT}/procs/by-session/${encodeURIComponent(sessionId)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.rows) ? body.rows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** One compact line per process. Format prioritizes the bits a model
 * actually needs to act: bash_id (so it can kill / tail), what binary,
 * any HTTP URL it's serving, and how long it's been up. */
function formatRow(row) {
  const handle = row.bash_id ?? `pid ${row.pid}`;
  const runtime = row.runtime ?? 'process';
  const framework = row.framework ? `/${row.framework}` : '';
  const cmd = truncate(row.hook_command ?? row.command ?? '', 60);
  const url = pickUrl(row.ports);
  const where = url ? ` ${url}` : '';
  const age = formatAge(row.uptime_s);
  return `${handle}  ${runtime}${framework}${where}  up ${age}  — ${cmd}`;
}

function pickUrl(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  // Prefer a confirmed-HTTP port; fall back to the first inherited-or-own
  // port so wrapper rows (npm, run-p) still get a URL when their child
  // is the actual binder.
  const http = ports.find((p) => p.is_http === true);
  const chosen = http ?? ports[0];
  if (!chosen) return null;
  return `http://localhost:${chosen.port}`;
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function formatAge(seconds) {
  if (!seconds || seconds < 60) return `${Math.max(0, Math.floor(seconds || 0))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

main().catch(async (err) => {
  if (!process.env.BRAINHOUSE_HOOK_DEBUG) return;
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const logPath = path.join(os.homedir(), '.brainhouse', 'dispatcher.log');
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${new Date().toISOString()} session-procs-reminder: ${err?.stack ?? err}\n`,
      'utf8',
    );
  } catch {
    /* nothing to do */
  }
});
