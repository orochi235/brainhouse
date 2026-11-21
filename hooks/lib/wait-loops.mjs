/**
 * Finds a Claude Code session's stuck `until …; do sleep N; done` wait loops.
 *
 * A background Bash task outlives `/clear` and the agent that started it, so a
 * loop polling for a log line that never comes runs as long as the `claude`
 * process does — on 2026-11-07 one had been polling for 24 hours.
 */
import { statSync } from 'node:fs';

const STALE_S = 30 * 60;
const FOREIGN_REAP_S = 30 * 60;
const OWN_REAP_S = 3 * 3600;
const HARD_CAP_S = 12 * 3600;

const SESSION_PATH =
  /\/claude-\d+\/[^/\s'"]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//g;
const LOOP = /\b(until|while)\b[\s\S]*?\bdo\s+sleep\s+\d/;

/** `ps` etime, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  const [, d = 0, h = 0, mi, se] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se);
}

/** Rows of `ps -axo pid=,ppid=,etime=,command=`. */
export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m)
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), age: parseEtime(m[3]), command: m[4] });
  }
  return rows;
}

/** PIDs above `pid` in `rows`, its parent first, stopping before launchd. */
export function ancestorsOf(rows, pid) {
  const ppidOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const out = [];
  for (let p = ppidOf.get(pid); p !== undefined && p > 1 && !out.includes(p); p = ppidOf.get(p)) {
    out.push(p);
  }
  return out;
}

export function claudeAncestor(rows, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  for (let p = pid, hops = 0; p > 1 && hops < 20; hops++) {
    const row = byPid.get(p);
    if (!row) return null;
    const exe = row.command.split(/\s/)[0];
    if (exe.endsWith('/claude') || exe === 'claude') return p;
    p = row.ppid;
  }
  return null;
}

/** Paths the loop's command names, with `VAR=…` assignments substituted into `$VAR`. */
export function watchedPaths(command) {
  const vars = {};
  for (const m of command.matchAll(/\b([A-Z_][A-Z0-9_]*)=(\/[^\s;'"]+)/g)) vars[m[1]] = m[2];
  const expanded = command.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (all, v) => vars[v] ?? all);
  const body = expanded.replace(/^[\s\S]*?\beval\s+'/, '');
  const paths = new Set();
  for (const m of body.matchAll(/\/(?:private|tmp|Users|var)\/[^\s;'"|&)]+/g)) {
    if (!m[0].includes('/shell-snapshots/') && !m[0].startsWith('/tmp/claude-')) paths.add(m[0]);
  }
  return [...paths];
}

/** A directory's mtime moves whenever anything lands in it, so only files count. */
function defaultMtime(p) {
  try {
    const st = statSync(p);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Wait loops owned by `claudePid`, each with a verdict: `reap`, `suspect`
 * (stuck but still this session's, so the model decides), or nothing.
 */
export function classify(rows, { claudePid, sessionId, now = Date.now(), mtime = defaultMtime }) {
  const out = [];
  for (const row of rows) {
    if (
      row.ppid !== claudePid ||
      !row.command.includes('/shell-snapshots/') ||
      !LOOP.test(row.command)
    )
      continue;
    const sessions = [...new Set([...row.command.matchAll(SESSION_PATH)].map((m) => m[1]))];
    const foreign = sessions.length > 0 && !sessions.includes(sessionId);
    const paths = watchedPaths(row.command);
    const freshest = Math.max(-Infinity, ...paths.map(mtime).filter((t) => t != null));
    const quietFor = Number.isFinite(freshest) ? Math.max(0, (now - freshest) / 1000) : row.age;
    const stale = row.age >= STALE_S && quietFor >= STALE_S;
    let verdict = null;
    if (row.age >= HARD_CAP_S) verdict = 'reap';
    else if (stale && foreign && row.age >= FOREIGN_REAP_S) verdict = 'reap';
    else if (stale && row.age >= OWN_REAP_S) verdict = 'reap';
    else if (stale) verdict = 'suspect';
    if (verdict) out.push({ ...row, verdict, foreign, sessions, paths, quietFor });
  }
  return out;
}

export function formatAge(s) {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

export function describe(loop) {
  const from = loop.foreign ? `, from session ${loop.sessions[0].slice(0, 8)}` : '';
  const target = loop.paths[0] ? `, watching ${loop.paths[0].split('/').pop()}` : '';
  return `pid ${loop.pid} (up ${formatAge(loop.age)}${from}${target}, quiet ${formatAge(loop.quietFor)})`;
}
