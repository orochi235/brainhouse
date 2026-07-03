/**
 * Filesystem-watch backend with a platform split.
 *
 * chokidar v4 dropped its `fsevents` optional dependency, so on macOS it
 * silently degrades to a per-*file* `fs.watch`, opening one file descriptor per
 * watched file. Watching a couple thousand transcripts that way exhausts the
 * process fd limit; once no fds are free, libuv can't allocate child-stdio pipes
 * and every `child_process` spawn fails `EBADF` (see roots.ts / TODO.md). That
 * fd blow-up is macOS-specific: on Linux chokidar uses inotify (one watch per
 * *directory*, governed by a separate limit), which is fine.
 *
 * So this module watches via the OS's native recursive watcher where that's
 * cheap and reliable — macOS (FSEvents) and Windows (ReadDirectoryChangesW),
 * one handle per root regardless of file count — and keeps chokidar as the
 * fallback everywhere else (Linux is semi-supported: it works, on the watcher
 * it was always fine on). Native `fs.watch({recursive:true})` only landed on
 * Linux in Node 20.13+ and still carries caveats, so we don't rely on it there.
 *
 * The consumer contract is deliberately minimal — `onEvent(absPath)` on any
 * add/change — because both callers re-read the file from a persisted byte
 * offset. That makes duplicate or coalesced events harmless (a re-read past EOF
 * is a no-op), which is what lets the coarse native events stand in for
 * chokidar's per-file precision.
 */

import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';

export type WatchEventHandler = (absPath: string) => void;

export interface WatchOptions {
  /** Watch nested subdirectories. Transcript roots need this (projects hold
   * per-cwd subdirs + subagent dirs); the flat hook-events dir does not. */
  recursive: boolean;
  /** Fired with an absolute path on every add/change under a root. */
  onEvent: WatchEventHandler;
  /**
   * Native-backend safety net (the "periodically scan for activity" backstop):
   * every `reconcileIntervalMs`, re-emit any file modified within this window so
   * a coalesced/dropped FSEvents notification can't strand a session's trailing
   * lines. 0 (default) disables it. Ignored by the chokidar backend, which does
   * its own bookkeeping.
   */
  reconcileWindowMs?: number;
  reconcileIntervalMs?: number;
  /** Force a backend. Test seam; also lets a caller opt into chokidar. */
  backend?: 'native' | 'chokidar';
  /** Passed through to chokidar when that backend is used (test seam). */
  chokidarOptions?: ChokidarOptions;
}

export interface Watcher {
  /** Resolves once the watch is armed (chokidar's initial scan complete; native
   * is armed synchronously). Callers await this so writes landing right after
   * start() can't slip through before the watch exists. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/** True on platforms whose native `fs.watch` has a real kernel recursive
 * backend we trust: macOS (FSEvents) and Windows (ReadDirectoryChangesW). */
export function nativeRecursiveSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

function chooseBackend(opts: WatchOptions): 'native' | 'chokidar' {
  if (opts.backend) return opts.backend;
  // Non-recursive watches are cheap under chokidar everywhere (a single dir),
  // but native is still fine and keeps one code path; gate purely on platform.
  return nativeRecursiveSupported() ? 'native' : 'chokidar';
}

/** Start watching `roots`, dispatching add/change to `opts.onEvent`. */
export function startWatcher(roots: string[], opts: WatchOptions): Watcher {
  return chooseBackend(opts) === 'native'
    ? startNativeWatcher(roots, opts)
    : startChokidarWatcher(roots, opts);
}

// Coalesce a burst of native events for the same path into one emit. Native
// fs.watch (unlike chokidar) can fire several times per write; the offset
// re-read dedupes anyway, but collapsing the burst avoids redundant reads.
const COALESCE_MS = 15;

function startNativeWatcher(roots: string[], opts: WatchOptions): Watcher {
  const handles: fs.FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const emit = (abs: string) => {
    const prev = timers.get(abs);
    if (prev) clearTimeout(prev);
    timers.set(
      abs,
      setTimeout(() => {
        timers.delete(abs);
        if (!closed) opts.onEvent(abs);
      }, COALESCE_MS),
    );
  };

  for (const root of roots) {
    try {
      const w = fs.watch(root, { recursive: opts.recursive, persistent: true }, (_event, filename) => {
        if (!filename) return; // no path detail — reconcile (if enabled) covers it
        const rel = filename.toString();
        emit(path.isAbsolute(rel) ? rel : path.resolve(root, rel));
      });
      // A watched root that later vanishes emits 'error' (ENOENT); ignore so a
      // removed account dir can't crash the server.
      w.on('error', () => undefined);
      handles.push(w);
    } catch {
      // Root missing at start — skip it, matching chokidar's tolerance and the
      // bootstrap's existsSync guards.
    }
  }

  const reconcile = startReconcile(roots, opts, () => closed, emit);

  return {
    ready: Promise.resolve(),
    close: async () => {
      closed = true;
      reconcile?.();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of handles) w.close();
    },
  };
}

/** Periodic re-stat backstop for the native backend. Returns a stop fn, or null
 * when disabled. Walks each root, re-emitting files touched within the window —
 * cheap (stat only, no held fds) and self-correcting via the offset re-read. */
function startReconcile(
  roots: string[],
  opts: WatchOptions,
  isClosed: () => boolean,
  emit: WatchEventHandler,
): (() => void) | null {
  const windowMs = opts.reconcileWindowMs ?? 0;
  const intervalMs = opts.reconcileIntervalMs ?? 0;
  if (windowMs <= 0 || intervalMs <= 0) return null;

  const scan = async () => {
    const cutoff = Date.now() - windowMs;
    for (const root of roots) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        if (dir === undefined) break;
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (opts.recursive) stack.push(full);
            continue;
          }
          if (!e.isFile()) continue;
          try {
            if ((await stat(full)).mtimeMs >= cutoff) emit(full);
          } catch {
            // raced/removed — skip
          }
        }
      }
    }
  };

  const timer = setInterval(() => {
    if (isClosed()) return;
    void scan();
  }, intervalMs);
  // Don't keep the event loop alive solely for the reconcile tick.
  timer.unref?.();
  return () => clearInterval(timer);
}

function startChokidarWatcher(roots: string[], opts: WatchOptions): Watcher {
  const watcher: FSWatcher = chokidar.watch(roots, {
    ignoreInitial: true,
    awaitWriteFinish: false,
    persistent: true,
    ...(opts.recursive ? {} : { depth: 0 }),
    ...opts.chokidarOptions,
  });
  const handle = (p: string) => opts.onEvent(p);
  watcher.on('add', handle).on('change', handle);
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  return {
    ready,
    close: async () => {
      await watcher.close();
    },
  };
}
