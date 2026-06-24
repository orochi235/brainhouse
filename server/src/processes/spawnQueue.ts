/**
 * The server's single chokepoint for spawning child processes.
 *
 * Transient `spawn` failures (EBADF/EMFILE/ENFILE/EAGAIN) are a libuv fd race
 * that arises whenever *any* two `child_process` spawns overlap in the same
 * process — it is NOT specific to one command. The process tracker fires
 * `ps` + `lsof` every tick, port sweeps pile on, and `.hued` theme polling
 * shells out to `git` for every session; left unsynchronized these race each
 * other constantly. Routing every spawn through {@link execWithRetry} (which
 * gates on a shared semaphore) serializes them so the race can't happen, and
 * gives one place to measure what's left ({@link getSpawnDiagnostics}).
 */

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

/** Observability for the transient-spawn-failure problem. We can't always
 * prevent the race, but we can measure it: which command, how many were in
 * flight, how often it self-heals on retry vs. surfaces. Read via
 * {@link getSpawnDiagnostics} (e.g. from a debug surface) or watch the one-line
 * warning emitted when retries are exhausted. */
export interface SpawnDiagnostics {
  /** child_process spawns currently mid-flight (≤ {@link MAX_CONCURRENT_SPAWNS}). */
  inFlight: number;
  /** High-water mark of {@link inFlight} since the last reset. With spawns
   * serialized this should sit at {@link MAX_CONCURRENT_SPAWNS}; a higher value
   * means something is spawning outside this gate. */
  peakInFlight: number;
  /** Every transient spawn error observed, by errno code (incl. ones that then
   * succeeded on retry — the silent majority that never reached a log). */
  transient: Record<string, number>;
  /** Transient errors that exhausted all retries and surfaced to the caller. */
  exhausted: Record<string, number>;
  /** Rolling tail of exhaustion contexts for quick eyeballing. */
  recent: Array<{ label: string; code: string; attempts: number; peakInFlight: number }>;
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

/** Max child_process spawns allowed in flight at once. The fd race only shows
 * up when several spawns overlap, so serializing to one at a time removes it;
 * the cost is negligible for sub-second shell-outs (each carries its own
 * timeout). Bump only if a profile shows the queue is a bottleneck — but then
 * the race can return, so prefer keeping it at 1. */
const MAX_CONCURRENT_SPAWNS = 1;

/** FIFO of callers parked because the gate is full; each is resumed by a
 * finishing spawn's `finally`. */
const spawnWaiters: Array<() => void> = [];

/** Run `fn` through the global spawn semaphore (≤ {@link MAX_CONCURRENT_SPAWNS}
 * at once), tracking the in-flight gauge around the actual spawn. Only the spawn
 * is gated — {@link execWithRetry}'s backoff sleeps happen outside the permit,
 * so a retrying call doesn't hold the gate while it waits. */
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

/** Run a child-process thunk through the shared spawn gate, retrying transient
 * `spawn` failures with a short linear backoff. `execFileAsync` can throw
 * `spawn EBADF` *synchronously* when libuv loses an fd race (the error is raised
 * before the promise is returned), so `await fn()` inside `serializeSpawn`
 * catches both the synchronous throw and the async rejection. Non-transient
 * errors and the final attempt rethrow.
 *
 * `label` names the command (e.g. `ps`, `lsof:cwd`, `git:common-dir`) so the
 * diagnostics and the exhaustion warning can pinpoint which shell-out failed.
 * ALL server child-process spawns should go through here — a spawn that bypasses
 * the gate can still race the gated ones and reintroduce EBADF. */
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
        recentExhaustions.push({ label, code, attempts, peakInFlight });
        if (recentExhaustions.length > RECENT_CAP) recentExhaustions.shift();
        // One concise line (not the raw multi-line spawn stack) with the context
        // needed to locate the source: which command, and the peak concurrency
        // seen — which should sit at MAX_CONCURRENT_SPAWNS now that spawns are
        // serialized, so a surviving EBADF points outside this gate.
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
