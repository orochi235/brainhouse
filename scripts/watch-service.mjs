// Dev supervisor for the brainhouse service (`npm run start:watch`).
//
// Runs the built server and redeploys it as sources change:
//   client/src edit  → in-process `vite build` → server nudges browsers to
//                      reload (it polls its public dir's mtime)
//   server/src edit  → `tsc` → restart the server child (clients reconnect
//                      over SSE and re-bootstrap)
//
// Polls source mtimes instead of fs.watch: FSEvents silently drops events on
// this machine (see server/src/watchBackend.ts, which carries a reconcile
// backstop for the same reason), and rolldown-vite's `build --watch` never
// fires after its initial build at all.
import { spawn } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL_MS = 2000;
const CLIENT_ROOT = path.join(ROOT, 'client');
const CLIENT_SRC = path.join(CLIENT_ROOT, 'src');
const SERVER_SRC = path.join(ROOT, 'server', 'src');
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');

/** Cheap change fingerprint for a tree: file count + newest mtime. Count
 * catches adds/deletes whose mtimes wouldn't advance the max. */
async function fingerprint(dir, extraFiles = []) {
  let newest = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        count++;
        try {
          const m = (await fsp.stat(full)).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          // raced/removed — the count delta still registers
        }
      }
    }
  }
  for (const f of extraFiles) {
    try {
      const m = (await fsp.stat(f)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // optional file absent
    }
  }
  return `${count}:${newest}`;
}

const clientFingerprint = () =>
  fingerprint(CLIENT_SRC, [
    path.join(CLIENT_ROOT, 'index.html'),
    path.join(CLIENT_ROOT, 'vite.config.ts'),
  ]);
const serverFingerprint = () => fingerprint(SERVER_SRC);

let server = null;
let stoppingServer = false;

function startServer() {
  server = spawn(process.execPath, [SERVER_ENTRY], { stdio: 'inherit', env: process.env });
  server.on('exit', (code, signal) => {
    if (stoppingServer) return;
    console.error(`[watch-service] server exited (${code ?? signal}); restarting in 1s`);
    setTimeout(startServer, 1000);
  });
}

async function restartServer() {
  const prev = server;
  if (prev && prev.exitCode === null) {
    stoppingServer = true;
    await new Promise((resolve) => {
      prev.once('exit', resolve);
      prev.kill('SIGTERM');
      const force = setTimeout(() => prev.kill('SIGKILL'), 3000);
      force.unref?.();
    });
    stoppingServer = false;
  }
  startServer();
}

async function buildClient() {
  try {
    await build({ root: CLIENT_ROOT, logLevel: 'warn' });
    console.log(`[watch-service] client rebuilt ${new Date().toLocaleTimeString()}`);
    return true;
  } catch (e) {
    // Mid-edit syntax errors are routine; keep the last good bundle.
    console.error('[watch-service] client build failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

function buildServer() {
  return new Promise((resolve) => {
    const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const p = spawn(process.execPath, [tsc, '-p', path.join(ROOT, 'server', 'tsconfig.json')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    p.on('exit', (code) => resolve(code === 0));
  });
}

// Cold start: build whatever's missing, then serve and poll.
if (!existsSync(SERVER_ENTRY)) await buildServer();
if (!existsSync(path.join(ROOT, 'server', 'dist', 'public', 'index.html'))) await buildClient();

let lastClient = await clientFingerprint();
let lastServer = await serverFingerprint();
startServer();
console.log(`[watch-service] serving; polling sources every ${POLL_MS}ms`);

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const [cf, sf] = await Promise.all([clientFingerprint(), serverFingerprint()]);
    if (cf !== lastClient) {
      lastClient = cf;
      await buildClient();
    }
    if (sf !== lastServer) {
      lastServer = sf;
      if (await buildServer()) {
        console.log(
          `[watch-service] server rebuilt; restarting ${new Date().toLocaleTimeString()}`,
        );
        await restartServer();
      } else {
        console.error('[watch-service] server build failed; still running the previous build');
      }
    }
  } finally {
    busy = false;
  }
}, POLL_MS);
