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

/** Observability for the transient-spawn-failure problem. EBADF & friends are
 * an fd race that climbs with the number of `child_process` spawns in flight at
 * once (each tick fires `ps` + `lsof` concurrently, and port sweeps overlap).
 * We can't always prevent the race, but we can measure it: which command, how
 * many were in flight, how often it self-heals on retry vs. surfaces. Read via
 * {@link getSpawnDiagnostics} (e.g. from a debug surface) or watch the
 * one-line warning emitted when retries are exhausted. */
export interface SpawnDiagnostics {
  /** child_process spawns currently mid-flight across all callers. */
  inFlight: number;
  /** High-water mark of {@link inFlight} since the last reset — the headline
   * signal for "is this a concurrency race?" */
  peakInFlight: number;
  /** Every transient spawn error observed, by errno code (incl. ones that then
   * succeeded on retry — the silent majority that never reached a log). */
  transient: Record<string, number>;
  /** Transient errors that exhausted all retries and surfaced to the caller. */
  exhausted: Record<string, number>;
  /** Rolling tail of exhaustion contexts for quick eyeballing. */
  recent: Array<{ label: string; code: string; attempts: number; inFlight: number; peakInFlight: number }>;
}

const RECENT_CAP = 20;
let inFlight = 0;
let peakInFlight = 0;
const transientCounts = new Map<string, number>();
const exhaustedCounts = new Map<string, number>();
let recentExhaustions: SpawnDiagnostics['recent'] = [];

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/** Max child_process spawns allowed in flight at once. The transient `spawn`
 * failures (EBADF/EMFILE/…) are a libuv fd race that only shows up when several
 * spawns overlap — each tick fires `ps` + `lsof` concurrently and port sweeps
 * pile on. Serializing to one at a time removes the race entirely; the cost is
 * negligible since these are sub-second shell-outs (and each carries a 3s
 * timeout). Bump this only if a future profile shows the queue is a bottleneck
 * — but then the race can return, so prefer keeping it at 1. */
const MAX_CONCURRENT_SPAWNS = 1;

/** FIFO of callers parked because the spawn queue is full; each is resumed by a
 * finishing spawn's `finally`. */
const spawnWaiters: Array<() => void> = [];

/** Run `fn` through the global spawn semaphore (≤ {@link MAX_CONCURRENT_SPAWNS}
 * at once), tracking the in-flight gauge around the actual spawn. Only the spawn
 * is gated — `execWithRetry`'s backoff sleeps happen outside the slot, so a
 * retrying call doesn't hold a permit while it waits. */
async function serializeSpawn<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlight >= MAX_CONCURRENT_SPAWNS) {
    await new Promise<void>((resolve) => spawnWaiters.push(resolve));
  }
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  try {
    return await fn();
  } finally {
    inFlight--;
    spawnWaiters.shift()?.();
  }
}

/** Snapshot of the spawn-failure counters. Maps are copied out so callers can't
 * mutate internal state. */
export function getSpawnDiagnostics(): SpawnDiagnostics {
  return {
    inFlight,
    peakInFlight,
    transient: Object.fromEntries(transientCounts),
    exhausted: Object.fromEntries(exhaustedCounts),
    recent: recentExhaustions.slice(),
  };
}

/** Reset all spawn diagnostics. Primarily for tests; also handy to zero the
 * peak after investigating a spike. */
export function resetSpawnDiagnostics(): void {
  inFlight = 0;
  peakInFlight = 0;
  transientCounts.clear();
  exhaustedCounts.clear();
  recentExhaustions = [];
}

/** Run a child-process thunk, retrying transient `spawn` failures with a short
 * linear backoff. `execFileAsync` can throw `spawn EBADF` *synchronously* when
 * libuv loses an fd race (the error is raised before the promise is returned),
 * so `await fn()` inside the try catches both the synchronous throw and the
 * async rejection. Non-transient errors and the final attempt rethrow.
 *
 * `label` names the command (e.g. `ps`, `lsof:cwd`) so the diagnostics and the
 * exhaustion warning can pinpoint which shell-out is racing. Every attempt is
 * counted against a shared in-flight gauge so a spike correlates the failures
 * with concurrency. */
export async function execWithRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 50, label = 'spawn' }: { attempts?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await serializeSpawn(fn);
    } catch (e) {
      lastErr = e;
      const transient = isTransientSpawnError(e);
      if (!transient) throw e;
      const code = (e as { code?: string }).code ?? 'UNKNOWN';
      bump(transientCounts, code);
      if (i === attempts - 1) {
        bump(exhaustedCounts, code);
        recentExhaustions.push({ label, code, attempts, inFlight, peakInFlight });
        if (recentExhaustions.length > RECENT_CAP) recentExhaustions.shift();
        // One concise line (not the raw multi-line spawn stack) with the context
        // needed to locate the source: which command, and the peak concurrency
        // seen — which should now sit at MAX_CONCURRENT_SPAWNS since spawns are
        // serialized, so a surviving EBADF points somewhere other than our race.
        console.warn(
          `[processes] spawn ${code} on "${label}" exhausted after ${attempts} attempts ` +
            `(peakInFlight=${peakInFlight}) — transient spawn failure`,
        );
        throw e;
      }
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
  const { stdout } = await execWithRetry(
    () =>
      execFileAsync(
        'ps', ['-A', '-o', 'pid,ppid,lstart,comm,command'],
        { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
      ),
    { label: 'ps' },
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
    const { stdout } = await execWithRetry(
      () =>
        execFileAsync(
          'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pPn'],
          { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
        ),
      { label: 'lsof:ports' },
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
    const { stdout } = await execWithRetry(
      () =>
        execFileAsync(
          'lsof', ['-d', 'cwd', '-Fpn'],
          { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
        ),
      { label: 'lsof:cwd' },
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
