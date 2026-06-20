import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Transient `spawn` failures from libuv under concurrent child_process load.
 * EBADF is an fd race (NOT exhaustion — the fd ulimit is ~1M), EMFILE/ENFILE
 * are momentary fd pressure, EAGAIN a momentary process-table limit. All clear
 * on a short retry; only the persistent variants should surface. */
const TRANSIENT_SPAWN_CODES = new Set(['EBADF', 'EMFILE', 'ENFILE', 'EAGAIN']);

function isTransientSpawnError(e: unknown): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    (e as { syscall?: unknown }).syscall === 'spawn' &&
    TRANSIENT_SPAWN_CODES.has((e as { code?: string }).code ?? '')
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run a child-process thunk, retrying transient `spawn` failures with a short
 * linear backoff. `execFileAsync` can throw `spawn EBADF` *synchronously* when
 * libuv loses an fd race (the error is raised before the promise is returned),
 * so `await fn()` inside the try catches both the synchronous throw and the
 * async rejection. Non-transient errors and the final attempt rethrow. */
export async function execWithRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 50 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientSpawnError(e) || i === attempts - 1) throw e;
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

export type PsRow = { pid: number; ppid: number; start_ts: number; comm: string; command: string };
export type PortRow = { pid: number; ports: Array<{ proto: 'TCP'; addr: string; port: number }> };

export function parsePsOutput(out: string): PsRow[] {
  const lines = out.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const rows: PsRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+[ \d]\d\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/);
    if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5]) continue;
    rows.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      start_ts: Date.parse(m[3]) * 1_000_000,
      comm: m[4],
      command: m[5],
    });
  }
  return rows;
}

export function parseLsofOutput(out: string): PortRow[] {
  const rows: PortRow[] = [];
  let cur: PortRow | null = null;
  let pendingProto: 'TCP' | null = null;
  for (const raw of out.split('\n')) {
    if (raw.length === 0) continue;
    const tag = raw[0]; const val = raw.slice(1);
    if (tag === 'p') {
      if (cur) rows.push(cur);
      cur = { pid: parseInt(val, 10), ports: [] };
      pendingProto = null;
    } else if (tag === 'P') {
      pendingProto = val === 'TCP' ? 'TCP' : null;
    } else if (tag === 'n' && cur && pendingProto === 'TCP') {
      const idx = val.lastIndexOf(':');
      if (idx > 0) {
        const addr = val.slice(0, idx);
        const port = parseInt(val.slice(idx + 1), 10);
        if (Number.isFinite(port)) cur.ports.push({ proto: 'TCP', addr, port });
      }
    }
  }
  if (cur) rows.push(cur);
  // Collapse IPv4/IPv6 dual-stack entries: a process listening on the
  // same port via 0.0.0.0 and :: emits two records; UI cares about one.
  // Dedupe by (proto, port); prefer loopback/wildcard over per-iface.
  for (const r of rows) {
    const byKey = new Map<string, { proto: 'TCP'; addr: string; port: number }>();
    for (const p of r.ports) {
      const key = `${p.proto}:${p.port}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, p); continue; }
      // Prefer entries that yield a clickable URL.
      const prevLoop = prev.addr === '127.0.0.1' || prev.addr === '*' || prev.addr === '::1' || prev.addr === '0.0.0.0';
      const curLoop = p.addr === '127.0.0.1' || p.addr === '*' || p.addr === '::1' || p.addr === '0.0.0.0';
      if (curLoop && !prevLoop) byKey.set(key, p);
    }
    r.ports = Array.from(byKey.values());
  }
  return rows;
}

export async function listProcesses(): Promise<PsRow[]> {
  const { stdout } = await execWithRetry(() =>
    execFileAsync(
      'ps', ['-A', '-o', 'pid,ppid,lstart,comm,command'],
      { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  return parsePsOutput(stdout);
}

/** Returns the listening-socket rows, or `null` when the lsof call
 * itself failed (timeout under load, fork/exec storm, spawn error). The
 * `null` vs `[]` distinction matters: a genuine empty result means "no
 * listeners," but a failure means "we don't know" — and the port
 * sweeper must NOT treat the latter as "every port disappeared," or
 * every network row flickers out and back on the next good sample. */
export async function listListeningPorts(): Promise<PortRow[] | null> {
  try {
    const { stdout } = await execWithRetry(() =>
      execFileAsync(
        'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pPn'],
        { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
      ),
    );
    return parseLsofOutput(stdout);
  } catch {
    return null;
  }
}

/** Parse `lsof -d cwd -Fpn` output into a pid → cwd map. The -F format
 * emits records as `p<pid>` followed by `n<path>` lines. */
export function parseLsofCwdOutput(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let curPid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      const pid = parseInt(val, 10);
      curPid = Number.isFinite(pid) ? pid : null;
    } else if (tag === 'n' && curPid !== null) {
      // Only keep the first 'n' line per pid (the cwd entry).
      if (!map.has(curPid)) map.set(curPid, val);
    }
  }
  return map;
}

/** Process cwds for every process the user can see. Used for the
 * heuristic cwd-match attribution tier — pairs an unattributed process
 * with a registered Claude session whose cwd matches. Single shell-out
 * per tick; we cache nothing because cwds can change (cd in a shell). */
export async function listCwds(): Promise<Map<number, string>> {
  try {
    const { stdout } = await execWithRetry(() =>
      execFileAsync(
        'lsof', ['-d', 'cwd', '-Fpn'],
        { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    return parseLsofCwdOutput(stdout);
  } catch {
    return new Map();
  }
}

export async function signalProcess(pid: number, sig: 'TERM' | 'KILL'): Promise<void> {
  if (pid <= 1000) throw new Error(`refused: pid ${pid} is system-reserved`);
  try { process.kill(pid, sig === 'TERM' ? 'SIGTERM' : 'SIGKILL'); }
  catch (e: any) { if (e.code !== 'ESRCH') throw e; }
}
