import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execWithRetry } from './spawnQueue.js';

// The shared spawn gate + diagnostics live in spawnQueue.ts. Re-export them here
// so existing importers/tests keep their path, and so it stays obvious that the
// `ps`/`lsof` shell-outs below run through the same gate as every other spawn.
export {
  execWithRetry,
  getSpawnDiagnostics,
  isTransientSpawnError,
  resetSpawnDiagnostics,
} from './spawnQueue.js';
export type { SpawnDiagnostics } from './spawnQueue.js';

const execFileAsync = promisify(execFile);

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
        { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
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
let lastLsofWarnAt = 0;

export async function listListeningPorts(): Promise<PortRow[] | null> {
  try {
    const { stdout } = await execWithRetry(
      () =>
        execFileAsync(
          'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pPn'],
          { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
        ),
      { label: 'lsof:ports' },
    );
    return parseLsofOutput(stdout);
  } catch (e) {
    // Null keeps the sweeper's cache untouched (see caller), but a
    // *persistently* failing lsof must not be invisible — it means the
    // Network view silently never populates. Log at most once a minute.
    const now = Date.now();
    if (now - lastLsofWarnAt > 60_000) {
      lastLsofWarnAt = now;
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      const code = (e as { code?: string | number })?.code;
      const signal = (e as { signal?: string })?.signal;
      console.warn(
        `[processes] lsof:ports failed (${msg}${code !== undefined ? ` code=${code}` : ''}${signal ? ` signal=${signal}` : ''}) — Network view ports may be stale`,
      );
    }
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
          { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
        ),
      { label: 'lsof:cwd' },
    );
    return parseLsofCwdOutput(stdout);
  } catch {
    return new Map();
  }
}

/** AppleScript that walks every iTerm2 window/tab/session, and when it finds
 * a session whose `id` matches the passed GUID (`item 1 of argv`), selects it
 * and brings iTerm2 to the front. `id of session` equals the GUID portion of
 * $ITERM_SESSION_ID, so this reveals the exact pane a Claude session runs in.
 * Returns "ok" on a hit, "notfound" otherwise. */
export const ITERM_REVEAL_SCRIPT_FOCUS = `on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is target then
            tell s to select
            tell t to select
            select w
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

/** No-focus variant: same pane-selection walk, but instead of `activate`
 * (which steals keyboard focus), System Events raises the now-front iTerm
 * window to the top of the global z-order via AXRaise. The frontmost app
 * keeps key focus. Requires an Accessibility grant for the calling
 * process; when missing, osascript errors and the caller resolves false
 * (pane still selected inside iTerm — a silent partial success). */
export const ITERM_REVEAL_SCRIPT_NOFOCUS = `on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is target then
            tell s to select
            tell t to select
            select w
            tell application "System Events" to tell process "iTerm2" to perform action "AXRaise" of window 1
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

/** Reveal the iTerm2 pane identified by `guid` (an $ITERM_SESSION_ID GUID).
 * macOS + iTerm2 only; returns false on any other platform, when iTerm2 isn't
 * running, when no live pane has that id, or when osascript errors. The GUID
 * is passed as an execFile argv entry (never a shell string), so it can't be
 * used to inject AppleScript. `focus: false` raises the window without
 * activating iTerm (see ITERM_REVEAL_SCRIPT_NOFOCUS). */
export async function revealItermSession(
  guid: string,
  opts: { focus?: boolean } = {},
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const script = (opts.focus ?? true) ? ITERM_REVEAL_SCRIPT_FOCUS : ITERM_REVEAL_SCRIPT_NOFOCUS;
  try {
    const { stdout } = await execWithRetry(
      () => execFileAsync('osascript', ['-e', script, guid], { timeout: 5000 }),
      { label: 'osascript:iterm-reveal' },
    );
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

export async function signalProcess(pid: number, sig: 'TERM' | 'KILL'): Promise<void> {
  if (pid <= 1000) throw new Error(`refused: pid ${pid} is system-reserved`);
  try { process.kill(pid, sig === 'TERM' ? 'SIGTERM' : 'SIGKILL'); }
  catch (e: any) { if (e.code !== 'ESRCH') throw e; }
}
