import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  const { stdout } = await execFileAsync(
    'ps', ['-A', '-o', 'pid,ppid,lstart,comm,command'],
    { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
  );
  return parsePsOutput(stdout);
}

export async function listListeningPorts(): Promise<PortRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pPn'],
      { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseLsofOutput(stdout);
  } catch {
    return [];
  }
}

export async function signalProcess(pid: number, sig: 'TERM' | 'KILL'): Promise<void> {
  if (pid <= 1000) throw new Error(`refused: pid ${pid} is system-reserved`);
  try { process.kill(pid, sig === 'TERM' ? 'SIGTERM' : 'SIGKILL'); }
  catch (e: any) { if (e.code !== 'ESRCH') throw e; }
}
