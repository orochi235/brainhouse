# scan-transforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic Node script (+ thin skill) that walks recent Claude Code logs, confirms each `SELECTOR_REGISTRY` selector still fires against real events, accumulates per-selector version metadata into a committed `observed.json`, and dumps unmatched-event clusters as transient new-transform candidates.

**Architecture:** A standalone tool under `scripts/scan-transforms/`, run via `tsx`. Pure, cross-workspace-free core modules (`version`, `cluster`, `merge`) are unit-tested in isolation. The `scan` orchestrator imports `parseLine` (server) and `resolveSelector`/`SELECTOR_REGISTRY` (client selector engine) — both reachable as plain `.ts` because the engine's only `@server` imports are type-only. The CLI entry walks the filesystem, calls the core, and writes outputs. A drift-guard test in the client workspace keeps `observed.json` 1:1 with the registry.

**Tech Stack:** TypeScript (ESM, `.mts`), `tsx` (runner), `vitest` (tests), Node `fs`/`path`. Reuses `server/src/parser.ts` and `client/src/transforms/selectors/{registry,parse,compile}.ts` + `components/transforms-inspector/inference.ts`.

---

## Key facts the engineer must know

- **`Event` has no `version` field.** Version lives only on the raw JSONL record (`raw.version`, e.g. `"2.1.112"`). The scanner reads each line as JSON, grabs `raw.version`, then calls `parseLine(raw)` and associates that one version with every `Event` the line produced.
- **Use `resolveSelector(key)` from `client/src/transforms/selectors/registry.ts`** — NOT anything from `selectors/index.ts` (that re-exports a mock). `resolveSelector` returns `{ source, ast, match }`; call `.match(event)`. It throws on an unknown key and memoizes compilation.
- **`SELECTOR_REGISTRY`** (same file) is `SelectorDef[]` with `{ key, name, description, selector, samplePayload? }`.
- **`infer(event)`** from `client/src/components/transforms-inspector/inference.ts` returns a draft selector string like `event[kind=tool_use] > tool_use[name=Foo]`. Used for cluster draft selectors.
- **`parseLine(raw, ctx?)`** from `server/src/parser.ts` returns `Event[]`. `Event['kind']` is one of `user_text | assistant_text | thinking | tool_use | tool_result | resource_usage | system | meta`. Payloads: `tool_use` → `{ tool_use_id, name, input }`; text kinds → `{ text }`.
- The selector engine imports `@server/parser.ts` **only as `import type`** (erased by esbuild/vitest), so no path-alias resolution is needed at runtime. The scanner imports `parseLine` itself via a **relative path** to avoid aliases entirely.
- Run scripts from repo root. `~` must be expanded via `os.homedir()`, never passed literally to `fs`.

## File Structure

- Create `scripts/scan-transforms/types.mts` — shared interfaces (`ObservedEntry`, `ObservedDb`, `ScanResult`, `Cluster`, `SelectorTally`).
- Create `scripts/scan-transforms/version.mts` — segment-wise version compare + `minVersion`/`maxVersion` (null-safe).
- Create `scripts/scan-transforms/version.test.mts`.
- Create `scripts/scan-transforms/cluster.mts` — `clusterKey(event)`, `accumulateClusters(...)`.
- Create `scripts/scan-transforms/cluster.test.mts`.
- Create `scripts/scan-transforms/merge.mts` — `mergeObserved(existing, result, scanAt)`.
- Create `scripts/scan-transforms/merge.test.mts`.
- Create `scripts/scan-transforms/scan.mts` — `scanLines(lines, scanAt)` core orchestration (no fs).
- Create `scripts/scan-transforms/__fixtures__/sample.jsonl` — integration fixture.
- Create `scripts/scan-transforms/scan.test.mts`.
- Create `scripts/scan-transforms.mts` — CLI entry: arg parse, fs walk, read/write files, summary.
- Create `client/src/transforms/selectors/observed.json` — committed sidecar (seeded).
- Create `client/src/transforms/selectors/observed.test.ts` — drift-guard (runs under client vitest).
- Create `vitest.scan.config.mts` — root vitest config scoped to `scripts/scan-transforms/**`.
- Modify `package.json` (root) — add `tsx` + `vitest` devDeps, `scan:transforms` + `test:scan` scripts.
- Modify `.gitignore` — ignore `scripts/.scan-out/`.

---

## Task 1: Tooling setup

**Files:**
- Modify: `package.json` (root)
- Create: `vitest.scan.config.mts`
- Modify: `.gitignore`

- [ ] **Step 1: Add dev dependencies**

Run:
```bash
npm install --save-dev --workspace-root tsx vitest
```
Expected: `tsx` and `vitest` appear under root `devDependencies`. (If `--workspace-root` is unsupported by the local npm, run `npm install -D tsx vitest` from the repo root directory.)

- [ ] **Step 2: Add npm scripts**

In root `package.json`, add to `"scripts"`:
```json
"scan:transforms": "tsx scripts/scan-transforms.mts",
"test:scan": "vitest run --config vitest.scan.config.mts"
```

- [ ] **Step 3: Create the scan vitest config**

Create `vitest.scan.config.mts`:
```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Type-only at runtime, but alias it anyway so transforms never choke.
      '@server': fileURLToPath(new URL('./server/src', import.meta.url)),
    },
  },
  test: {
    include: ['scripts/scan-transforms/**/*.test.mts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Ignore the transient output dir**

Append to `.gitignore`:
```
# scan-transforms discovery output (transient triage fodder)
scripts/.scan-out/
```

- [ ] **Step 5: Verify tooling runs**

Run: `npx vitest run --config vitest.scan.config.mts`
Expected: vitest starts and reports "No test files found" (no tests yet) — exit 0 or the "no tests" notice. Confirms the config loads.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.scan.config.mts .gitignore
git commit -m "build: tsx+vitest tooling for scan-transforms"
```

---

## Task 2: Version compare core

**Files:**
- Create: `scripts/scan-transforms/types.mts`
- Create: `scripts/scan-transforms/version.mts`
- Test: `scripts/scan-transforms/version.test.mts`

- [ ] **Step 1: Write shared types**

Create `scripts/scan-transforms/types.mts`:
```ts
/** One committed sidecar entry per selector key. */
export interface ObservedEntry {
  firstSeenVersion: string;
  lastSeenVersion: string;
  /** Recomputed fresh each run — current-window activity, not a lifetime total. */
  lastWindowCount: number;
  lastScanAt: string;
}
export type ObservedDb = Record<string, ObservedEntry>;

/** What one scan run saw for one selector. */
export interface SelectorTally {
  count: number;
  minVersion: string | null;
  maxVersion: string | null;
}

/** A bucket of events that matched no selector. */
export interface Cluster {
  shapeKey: string;
  count: number;
  sampleEvent: unknown;
  draftSelector: string;
}

export interface ScanResult {
  /** Keyed by selector key — one entry per registry selector, even count 0. */
  perSelector: Record<string, SelectorTally>;
  clusters: Cluster[];
  maxVersionSeen: string | null;
  stats: {
    linesParsed: number;
    malformedLines: number;
    eventsTotal: number;
    eventsMatchedZero: number;
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/scan-transforms/version.test.mts`:
```ts
import { describe, expect, it } from 'vitest';
import { compareVersions, maxVersion, minVersion } from './version.mts';

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    expect(compareVersions('2.1.112', '2.1.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.112')).toBeLessThan(0);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
  });
  it('treats missing segments as zero', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.2', '2.1.999')).toBeGreaterThan(0);
  });
});

describe('min/maxVersion', () => {
  it('is null-safe', () => {
    expect(maxVersion(null, '2.1.0')).toBe('2.1.0');
    expect(maxVersion('2.1.0', null)).toBe('2.1.0');
    expect(maxVersion(null, null)).toBeNull();
    expect(minVersion(null, '2.1.0')).toBe('2.1.0');
  });
  it('picks the numerically larger/smaller', () => {
    expect(maxVersion('2.1.9', '2.1.112')).toBe('2.1.112');
    expect(minVersion('2.1.9', '2.1.112')).toBe('2.1.9');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:scan`
Expected: FAIL — cannot resolve `./version.mts`.

- [ ] **Step 4: Implement**

Create `scripts/scan-transforms/version.mts`:
```ts
/** Segment-wise numeric comparison of dotted version strings ("2.1.112"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function maxVersion(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

export function minVersion(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return compareVersions(a, b) <= 0 ? a : b;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:scan`
Expected: PASS (version tests green).

- [ ] **Step 6: Commit**

```bash
git add scripts/scan-transforms/types.mts scripts/scan-transforms/version.mts scripts/scan-transforms/version.test.mts
git commit -m "feat(scan): version compare core + shared types"
```

---

## Task 3: Cluster keying

**Files:**
- Create: `scripts/scan-transforms/cluster.mts`
- Test: `scripts/scan-transforms/cluster.test.mts`

- [ ] **Step 1: Write the failing test**

Create `scripts/scan-transforms/cluster.test.mts`:
```ts
import type { Event } from '../../server/src/parser.ts';
import { describe, expect, it } from 'vitest';
import { clusterKey } from './cluster.mts';

function ev(partial: Partial<Event> & Pick<Event, 'kind' | 'payload'>): Event {
  return {
    session_id: 's', agent_id: null, uuid: 'u', parent_uuid: null,
    ts: '2026-06-20T00:00:00Z', cwd: null, tags: [],
    ...partial,
  } as Event;
}

describe('clusterKey', () => {
  it('keys tool_use by kind + tool name', () => {
    const k = clusterKey(ev({ kind: 'tool_use', payload: { tool_use_id: 't', name: 'NewTool', input: {} } }));
    expect(k).toBe('tool_use|NewTool');
  });
  it('keys text events by kind + detected markers', () => {
    const k = clusterKey(ev({ kind: 'assistant_text', payload: { text: 'hi <new-marker>stuff</new-marker>' } }));
    expect(k).toBe('assistant_text|<new-marker');
  });
  it('keys markerless text by kind alone', () => {
    expect(clusterKey(ev({ kind: 'assistant_text', payload: { text: 'plain' } }))).toBe('assistant_text|');
  });
  it('keys other kinds by kind', () => {
    expect(clusterKey(ev({ kind: 'system', payload: { subtype: null, content: null, level: null } }))).toBe('system|');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:scan`
Expected: FAIL — cannot resolve `./cluster.mts`.

- [ ] **Step 3: Implement**

Create `scripts/scan-transforms/cluster.mts`:
```ts
import type { Event } from '../../server/src/parser.ts';

/**
 * Coarse shape key for bucketing events that matched no selector.
 * tool_use → kind + tool name; text kinds → kind + first `<tag` marker
 * found (or empty); everything else → kind alone. Deliberately lossy:
 * the point is to group "the same new shape", not to be unique.
 */
export function clusterKey(e: Event): string {
  if (e.kind === 'tool_use') {
    const name = (e.payload as { name?: string }).name ?? '';
    return `tool_use|${name}`;
  }
  if (e.kind === 'user_text' || e.kind === 'assistant_text' || e.kind === 'thinking') {
    const text = (e.payload as { text?: string }).text ?? '';
    const m = text.match(/<[a-z][a-z0-9-]*/i);
    return `${e.kind}|${m ? m[0] : ''}`;
  }
  return `${e.kind}|`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:scan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan-transforms/cluster.mts scripts/scan-transforms/cluster.test.mts
git commit -m "feat(scan): cluster shape-keying for unmatched events"
```

---

## Task 4: Observed-db merge

**Files:**
- Create: `scripts/scan-transforms/merge.mts`
- Test: `scripts/scan-transforms/merge.test.mts`

- [ ] **Step 1: Write the failing test**

Create `scripts/scan-transforms/merge.test.mts`:
```ts
import type { ObservedDb, ScanResult } from './types.mts';
import { describe, expect, it } from 'vitest';
import { mergeObserved } from './merge.mts';

function result(perSelector: ScanResult['perSelector']): ScanResult {
  return { perSelector, clusters: [], maxVersionSeen: null,
    stats: { linesParsed: 0, malformedLines: 0, eventsTotal: 0, eventsMatchedZero: 0 } };
}

describe('mergeObserved', () => {
  const scanAt = '2026-06-20T00:00:00Z';

  it('creates entries for first-seen selectors', () => {
    const out = mergeObserved({}, result({ 'a.b': { count: 5, minVersion: '2.1.9', maxVersion: '2.1.112' } }), scanAt);
    expect(out['a.b']).toEqual({ firstSeenVersion: '2.1.9', lastSeenVersion: '2.1.112', lastWindowCount: 5, lastScanAt: scanAt });
  });

  it('widens version bounds cumulatively and refreshes the window count', () => {
    const existing: ObservedDb = { 'a.b': { firstSeenVersion: '2.0.0', lastSeenVersion: '2.1.50', lastWindowCount: 99, lastScanAt: 'old' } };
    const out = mergeObserved(existing, result({ 'a.b': { count: 3, minVersion: '2.1.10', maxVersion: '2.1.200' } }), scanAt);
    expect(out['a.b']).toEqual({ firstSeenVersion: '2.0.0', lastSeenVersion: '2.1.200', lastWindowCount: 3, lastScanAt: scanAt });
  });

  it('keeps version bounds but zeroes the count when a selector is unseen this run', () => {
    const existing: ObservedDb = { 'a.b': { firstSeenVersion: '2.0.0', lastSeenVersion: '2.1.50', lastWindowCount: 99, lastScanAt: 'old' } };
    const out = mergeObserved(existing, result({ 'a.b': { count: 0, minVersion: null, maxVersion: null } }), scanAt);
    expect(out['a.b']).toEqual({ firstSeenVersion: '2.0.0', lastSeenVersion: '2.1.50', lastWindowCount: 0, lastScanAt: scanAt });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:scan`
Expected: FAIL — cannot resolve `./merge.mts`.

- [ ] **Step 3: Implement**

Create `scripts/scan-transforms/merge.mts`:
```ts
import type { ObservedDb, ObservedEntry, ScanResult } from './types.mts';
import { maxVersion, minVersion } from './version.mts';

/**
 * Fold a scan result into the cumulative sidecar. Version bounds widen
 * forever (survive log pruning); lastWindowCount is replaced with this
 * run's count (0 when unseen). Iterates `result.perSelector`, which holds
 * one entry per registry selector — so the output stays 1:1 with the
 * registry.
 */
export function mergeObserved(existing: ObservedDb, result: ScanResult, scanAt: string): ObservedDb {
  const out: ObservedDb = {};
  for (const [key, tally] of Object.entries(result.perSelector)) {
    const prev = existing[key];
    const entry: ObservedEntry = {
      firstSeenVersion: minVersion(prev?.firstSeenVersion ?? null, tally.minVersion) ?? prev?.firstSeenVersion ?? tally.minVersion ?? 'unknown',
      lastSeenVersion: maxVersion(prev?.lastSeenVersion ?? null, tally.maxVersion) ?? prev?.lastSeenVersion ?? tally.maxVersion ?? 'unknown',
      lastWindowCount: tally.count,
      lastScanAt: scanAt,
    };
    out[key] = entry;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:scan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan-transforms/merge.mts scripts/scan-transforms/merge.test.mts
git commit -m "feat(scan): cumulative observed.json merge"
```

---

## Task 5: Scan orchestrator (no fs)

**Files:**
- Create: `scripts/scan-transforms/scan.mts`
- Create: `scripts/scan-transforms/__fixtures__/sample.jsonl`
- Test: `scripts/scan-transforms/scan.test.mts`

- [ ] **Step 1: Create the fixture**

Create `scripts/scan-transforms/__fixtures__/sample.jsonl` (each line a raw Claude Code record; the first matches `tool-use.todo-write`, the second is a novel tool, the third is malformed):
```
{"type":"assistant","version":"2.1.9","uuid":"u1","timestamp":"2026-06-20T00:00:00Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"TodoWrite","input":{"todos":[]}}]}}
{"type":"assistant","version":"2.1.112","uuid":"u2","timestamp":"2026-06-20T00:01:00Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu2","name":"BrandNewTool","input":{"x":1}}]}}
{not valid json
```
NOTE: If `parseLine` does not produce a `tool_use` event from this exact record shape, adjust the `message.content` shape to match what `server/src/parser.ts` expects (read `parseLine` and its helpers first). The test asserts behavior, not this literal text — keep the fixture in sync with the parser.

- [ ] **Step 2: Write the failing test**

Create `scripts/scan-transforms/scan.test.mts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanLines } from './scan.mts';

const fixture = readFileSync(fileURLToPath(new URL('./__fixtures__/sample.jsonl', import.meta.url)), 'utf8');
const lines = fixture.split('\n').filter((l) => l.trim().length > 0);

describe('scanLines', () => {
  const r = scanLines(lines, '2026-06-20T12:00:00Z');

  it('counts a malformed line without aborting', () => {
    expect(r.stats.malformedLines).toBe(1);
  });

  it('tallies the matching selector with its version', () => {
    const todo = r.perSelector['tool-use.todo-write'];
    expect(todo.count).toBe(1);
    expect(todo.maxVersion).toBe('2.1.9');
  });

  it('includes every registry selector, even count 0', () => {
    // pick a selector unlikely to appear in the fixture
    expect(r.perSelector['tool-use.ask-user-question'].count).toBe(0);
  });

  it('buckets the novel tool into a cluster with a draft selector', () => {
    const c = r.clusters.find((c) => c.shapeKey === 'tool_use|BrandNewTool');
    expect(c).toBeDefined();
    expect(c?.count).toBe(1);
    expect(c?.draftSelector).toContain('BrandNewTool');
  });

  it('tracks the max version seen across all lines', () => {
    expect(r.maxVersionSeen).toBe('2.1.112');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:scan`
Expected: FAIL — cannot resolve `./scan.mts`.

- [ ] **Step 4: Implement**

Create `scripts/scan-transforms/scan.mts`:
```ts
import { parseLine } from '../../server/src/parser.ts';
import { SELECTOR_REGISTRY, resolveSelector } from '../../client/src/transforms/selectors/registry.ts';
import { infer } from '../../client/src/components/transforms-inspector/inference.ts';
import { clusterKey } from './cluster.mts';
import type { Cluster, ScanResult, SelectorTally } from './types.mts';
import { maxVersion, minVersion } from './version.mts';

/**
 * Core scan over already-read JSONL lines. No filesystem — the CLI feeds
 * lines in so this stays unit-testable. Each line's `version` is read off
 * the raw record and attributed to every Event the line yields.
 */
export function scanLines(lines: string[], scanAt: string): ScanResult {
  const perSelector: Record<string, SelectorTally> = {};
  for (const def of SELECTOR_REGISTRY) {
    perSelector[def.key] = { count: 0, minVersion: null, maxVersion: null };
  }
  // Pre-resolve once; a broken registry entry is reported, not fatal.
  const matchers: Array<{ key: string; match: (e: ReturnType<typeof parseLine>[number]) => boolean }> = [];
  for (const def of SELECTOR_REGISTRY) {
    try {
      matchers.push({ key: def.key, match: resolveSelector(def.key).match });
    } catch (err) {
      process.stderr.write(`[scan] selector "${def.key}" failed to compile: ${String(err)}\n`);
    }
  }

  const clusters = new Map<string, Cluster>();
  const stats = { linesParsed: 0, malformedLines: 0, eventsTotal: 0, eventsMatchedZero: 0 };
  let maxVersionSeen: string | null = null;

  for (const line of lines) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      stats.malformedLines++;
      continue;
    }
    stats.linesParsed++;
    const version = typeof raw.version === 'string' ? raw.version : null;
    if (version) maxVersionSeen = maxVersion(maxVersionSeen, version);

    let events: ReturnType<typeof parseLine>;
    try {
      events = parseLine(raw);
    } catch {
      stats.malformedLines++;
      continue;
    }

    for (const e of events) {
      stats.eventsTotal++;
      let matchedAny = false;
      for (const m of matchers) {
        if (m.match(e)) {
          matchedAny = true;
          const t = perSelector[m.key];
          t.count++;
          t.minVersion = minVersion(t.minVersion, version);
          t.maxVersion = maxVersion(t.maxVersion, version);
        }
      }
      if (!matchedAny) {
        stats.eventsMatchedZero++;
        const key = clusterKey(e);
        const hit = clusters.get(key);
        if (hit) {
          hit.count++;
        } else {
          clusters.set(key, { shapeKey: key, count: 1, sampleEvent: e, draftSelector: infer(e) });
        }
      }
    }
  }

  return {
    perSelector,
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count),
    maxVersionSeen,
    stats,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:scan`
Expected: PASS. If the `tool-use.todo-write` assertion fails because no `tool_use` event was produced, read `server/src/parser.ts`'s assistant-message handling and fix the fixture's `message.content` shape (Step 1 note), then re-run.

- [ ] **Step 6: Commit**

```bash
git add scripts/scan-transforms/scan.mts scripts/scan-transforms/scan.test.mts scripts/scan-transforms/__fixtures__/sample.jsonl
git commit -m "feat(scan): orchestrate match + cluster over log lines"
```

---

## Task 6: CLI entry + filesystem walk

**Files:**
- Create: `scripts/scan-transforms.mts`

- [ ] **Step 1: Implement the CLI**

Create `scripts/scan-transforms.mts`:
```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeObserved } from './scan-transforms/merge.mts';
import { scanLines } from './scan-transforms/scan.mts';
import type { ObservedDb } from './scan-transforms/types.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVED_PATH = join(HERE, '..', 'client', 'src', 'transforms', 'selectors', 'observed.json');
const OUT_DIR = join(HERE, '.scan-out');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

function findLogs(root: string, sinceMs: number | null): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) {
        if (sinceMs == null || statSync(p).mtimeMs >= sinceMs) out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

function main() {
  const root = arg('--root') ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    process.stderr.write(`[scan] log root not found: ${root}\n`);
    process.exit(1);
  }
  const sinceDays = hasFlag('--all') ? null : Number.parseInt(arg('--since') ?? '14', 10);
  const sinceMs = sinceDays == null ? null : Date.now() - sinceDays * 86_400_000;
  const scanAt = new Date().toISOString();

  const files = findLogs(root, sinceMs);
  const lines: string[] = [];
  for (const f of files) {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (l.trim().length > 0) lines.push(l);
    }
  }

  const result = scanLines(lines, scanAt);

  const existing: ObservedDb = existsSync(OBSERVED_PATH)
    ? JSON.parse(readFileSync(OBSERVED_PATH, 'utf8'))
    : {};
  const merged = mergeObserved(existing, result, scanAt);
  writeFileSync(OBSERVED_PATH, `${JSON.stringify(merged, null, 2)}\n`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'unmatched-candidates.json'), `${JSON.stringify(result.clusters, null, 2)}\n`);

  // Summary.
  const maxV = result.maxVersionSeen ?? 'unknown';
  const stale = Object.entries(merged)
    .filter(([, e]) => e.lastWindowCount === 0)
    .map(([k]) => k);
  const lagging = Object.entries(merged)
    .filter(([, e]) => e.lastWindowCount > 0 && result.maxVersionSeen != null && e.lastSeenVersion !== result.maxVersionSeen)
    .map(([k]) => k);

  process.stdout.write(
    [
      `scan-transforms — ${files.length} files, ${result.stats.linesParsed} lines (${result.stats.malformedLines} malformed), ${result.stats.eventsTotal} events`,
      `max Claude version seen: ${maxV}`,
      `live selectors: ${Object.values(merged).filter((e) => e.lastWindowCount > 0).length}/${Object.keys(merged).length}`,
      stale.length ? `NOT SEEN this window (stale candidates): ${stale.join(', ')}` : 'no unseen selectors',
      lagging.length ? `lastSeenVersion < ${maxV}: ${lagging.join(', ')}` : '',
      `unmatched clusters: ${result.clusters.length} → ${join(OUT_DIR, 'unmatched-candidates.json')}`,
      'top clusters:',
      ...result.clusters.slice(0, 10).map((c) => `  ${c.count.toString().padStart(5)}  ${c.shapeKey}   draft: ${c.draftSelector}`),
    ].filter(Boolean).join('\n') + '\n',
  );
}

main();
```

- [ ] **Step 2: Smoke-run against real logs**

Run: `npm run scan:transforms -- --since 7`
Expected: prints the summary block; creates/updates `client/src/transforms/selectors/observed.json` and `scripts/.scan-out/unmatched-candidates.json`. (If you have no logs in the last 7 days, use `--all`.)

- [ ] **Step 3: Verify outputs exist and are well-formed**

Run: `node -e "const o=require('./client/src/transforms/selectors/observed.json'); console.log('entries:', Object.keys(o).length)"`
Expected: prints a positive entry count equal to the number of `SELECTOR_REGISTRY` selectors.

- [ ] **Step 4: Commit the script (observed.json is committed in Task 7)**

```bash
git add scripts/scan-transforms.mts
git commit -m "feat(scan): CLI entry — walk logs, write observed.json + clusters"
```

---

## Task 7: Seed observed.json + drift guard

**Files:**
- Create: `client/src/transforms/selectors/observed.json`
- Test: `client/src/transforms/selectors/observed.test.ts`

- [ ] **Step 1: Generate the seed**

The real scan from Task 6 already wrote `client/src/transforms/selectors/observed.json` with one entry per selector. Confirm it has an entry for every registry key:

Run: `node -e "const r=require('./client/src/transforms/selectors/registry.ts'.replace('.ts','')) " 2>/dev/null; node -e "const o=require('./client/src/transforms/selectors/observed.json'); console.log(Object.keys(o).sort().join('\n'))"`
Expected: lists all selector keys. (The registry is TS, so the authoritative key check is the drift-guard test below — this is just a sanity peek at the JSON.)

If for any reason `observed.json` does not exist yet (e.g. no logs available), create it by running the scan with `--all`, or hand-seed each `SELECTOR_REGISTRY` key with `{ "firstSeenVersion": "unknown", "lastSeenVersion": "unknown", "lastWindowCount": 0, "lastScanAt": "<now ISO>" }`.

- [ ] **Step 2: Write the drift-guard test**

Create `client/src/transforms/selectors/observed.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import observed from './observed.json';
import { SELECTOR_REGISTRY } from './registry.ts';

describe('observed.json drift guard', () => {
  const registryKeys = new Set(SELECTOR_REGISTRY.map((d) => d.key));
  const observedKeys = new Set(Object.keys(observed as Record<string, unknown>));

  it('has an entry for every registry selector', () => {
    const missing = [...registryKeys].filter((k) => !observedKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('has no entries for selectors absent from the registry', () => {
    const extra = [...observedKeys].filter((k) => !registryKeys.has(k));
    expect(extra).toEqual([]);
  });

  it('every entry has the expected shape', () => {
    for (const entry of Object.values(observed as Record<string, Record<string, unknown>>)) {
      expect(typeof entry.firstSeenVersion).toBe('string');
      expect(typeof entry.lastSeenVersion).toBe('string');
      expect(typeof entry.lastWindowCount).toBe('number');
      expect(typeof entry.lastScanAt).toBe('string');
    }
  });
});
```

- [ ] **Step 3: Verify the drift guard passes**

Run: `npm run test:client -- observed`
Expected: PASS (3 tests). If JSON-import typing errors occur, ensure `client/tsconfig.json` has `"resolveJsonModule": true` (it almost certainly does, since Vite handles JSON — if the test runner complains, add it).

- [ ] **Step 4: Commit**

```bash
git add client/src/transforms/selectors/observed.json client/src/transforms/selectors/observed.test.ts
git commit -m "feat(scan): seed observed.json + registry drift guard"
```

---

## Task 8: The thin skill

**Files:**
- Create: `.claude/skills/scan-transforms/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `.claude/skills/scan-transforms/SKILL.md`:
```markdown
---
name: scan-transforms
description: Use when checking whether our selector schema still matches real Claude Code logs, refreshing observed.json version metadata, or hunting for new event patterns worth a transform. Runs the deterministic scan and summarizes; only reasons about new candidates when asked.
---

# scan-transforms

Keep the selector schema (`client/src/transforms/selectors/registry.ts`) honest
against real Claude Code logs.

## Run the scan

From the repo root:

    npm run scan:transforms          # last 14 days
    npm run scan:transforms -- --all # full history
    npm run scan:transforms -- --since 30

This rewrites `client/src/transforms/selectors/observed.json` (committed) and
`scripts/.scan-out/unmatched-candidates.json` (transient, gitignored).

## Report (always)

After the run, summarize from the script's stdout + `observed.json`:

1. **Live selectors** — how many of N matched this window.
2. **Stale candidates** — selectors with `lastWindowCount: 0`, or whose
   `lastSeenVersion` lags the max Claude version in the logs. A selector that
   stops advancing across CC version bumps has probably had its trigger marker
   changed — flag it for a look at the corresponding transform.
3. **Top unmatched clusters** — the largest buckets from the candidates file,
   with their draft selectors.

Then stop. Do not auto-propose or write transforms.

## On request only

If the user asks "are any of these worth a transform?", read
`scripts/.scan-out/unmatched-candidates.json`, inspect the sample events, and
reason about which clusters represent a real recurring shape worth a selector +
transform. Reference `docs/transforms-schema.md` and the existing
`builtIn/*.ts` for the pattern.
```

- [ ] **Step 2: Verify the skill is discoverable**

Run: `cat .claude/skills/scan-transforms/SKILL.md | head -5`
Expected: prints the frontmatter. (The harness discovers `.claude/skills/*/SKILL.md` on next session start.)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/scan-transforms/SKILL.md
git commit -m "feat(scan): thin scan-transforms skill wrapper"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full scan test suite**

Run: `npm run test:scan`
Expected: all version/cluster/merge/scan tests PASS.

- [ ] **Step 2: Client suite (drift guard)**

Run: `npm run test:client -- observed`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run check`
Expected: biome passes for the new files (fix with `npm run fix` if formatting differs).

- [ ] **Step 4: End-to-end dry run**

Run: `npm run scan:transforms -- --all`
Expected: summary prints; `git status` shows only an `observed.json` update (clusters land in the gitignored `.scan-out/`). Commit the refreshed `observed.json` if it changed:
```bash
git add client/src/transforms/selectors/observed.json
git commit -m "chore(scan): refresh observed.json from full-history scan"
```

---

## Self-Review notes

- **Spec coverage:** sidecar `observed.json` (Task 7), fat deterministic script (Tasks 2–6), thin skill (Task 8), regression via cumulative version bounds + stale/lagging report (Tasks 4, 6), discovery clustering via `infer` (Tasks 3, 5), transient `.scan-out/` gitignored (Task 1), drift guard (Task 7), cross-workspace `tsx` runner (Task 1), segment-wise version compare (Task 2). All spec sections map to a task.
- **Window semantics:** `lastWindowCount` is current-window only; version bounds accumulate — matches the spec and the user's confirmed semantics.
- **Type consistency:** `ObservedEntry`/`ObservedDb`/`ScanResult`/`SelectorTally`/`Cluster` defined once in `types.mts` and used unchanged in `merge.mts`, `scan.mts`, and the CLI. `scanLines(lines, scanAt)`, `mergeObserved(existing, result, scanAt)`, `clusterKey(e)`, `compareVersions/min/maxVersion` signatures are consistent across tasks and tests.
- **Known soft spot:** the Task 5 fixture must match whatever `parseLine` expects for an assistant `tool_use` record; Step 1/Step 5 notes tell the engineer to read the parser and adjust. This is the one place to verify against real parser behavior rather than trust the literal fixture.
```
