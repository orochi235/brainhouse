# Process Memory Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every process row an RSS figure, surface it as a sortable column with subtree rollup in the top widget, and add a banner totaling memory held under long-idle Claude sessions so the user can filter to those trees and batch-kill them.

**Architecture:** `ps` gains an `rss` column, which flows through `PsRow` → `ProcessRow` → the delta stream on the 1 Hz upserts that already go out. Rollup and banner math live in a new pure client module (`client/src/lib/processMemory.ts`) tested directly, because `ProcessesPanel.tsx` is already ~700 lines. The UI adds one column, one header banner, and one warning glyph on rows that serve a listening port.

**Tech Stack:** TypeScript, Node (server), React 18 + Vite (client), vitest + @testing-library/react, biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-08-26-process-memory-accounting-design.md`

**Commands you will use repeatedly:**
- Server tests: `npm run test:server` (a single file: `npx vitest run src/processes/native.test.ts --root server`)
- Client tests: `npm run test:client` (a single file: `npx vitest run src/lib/processMemory.test.ts --root client`)
- Lint: `npx biome check <the paths you touched>`

**Do NOT run `npm run fix`.** It runs `biome check --write` across the whole
repo, and this repo is not biome-clean — it reformats ~90 files that have
nothing to do with your task, and there is uncommitted work in the tree.
Formatting is not enforced here. Lint only the paths you touched, and do not
reformat existing lines you did not otherwise change: a commit whose diff is
ten times its semantic change is unreviewable.

**Deployment note:** the service runs in watch mode (`scripts/watch-service.mjs`). Server/client source edits rebuild and redeploy within seconds; confirm via `~/Library/Logs/brainhouse/stdout.log`. Do not `launchctl kickstart` unless watch mode is off.

---

## File Structure

**Modified:**
- `server/src/processes/native.ts` — add `rss` to the `ps` invocation and `rss_kb` to `PsRow`; widen the parse regex.
- `server/src/processes/native.test.ts` — cover the new column.
- `server/src/processes/reconciler.ts` — `rss_kb` on `ProcessRow`, set in `createRow` and refreshed each tick.
- `server/src/processes/reconciler.test.ts` — assert `rss_kb` survives a tick.
- `client/src/useProcesses.ts` — mirror `rss_kb` on the client row type.
- `client/src/lib/format.ts` — `formatRss`.
- `client/src/lib/format.test.ts` — cover `formatRss`.
- `client/src/components/ProcessRow.tsx` — RSS cell, serving-warning glyph.
- `client/src/components/ProcessesPanel.tsx` — RSS sort key + header, per-row RSS display value, the banner, its threshold pref and filter.
- `client/src/components/ProcessesPanel.test.tsx` — fixture gains `rss_kb`; banner tests.
- `client/src/app.css` — banner, RSS cell, glyph styles.
- `docs/assertions.md` — one new behavior rule.

**Created:**
- `client/src/lib/processMemory.ts` — `subtreeRss`, `reclaimable`, `IDLE_THRESHOLDS`.
- `client/src/lib/processMemory.test.ts`
- `client/src/assets/icons/serving.svg`

---

### Task 1: `rss_kb` on `PsRow`

**Files:**
- Modify: `server/src/processes/native.ts:18` (the `PsRow` type), `:21-40` (`parsePsOutput`), `:83-93` (`listProcesses`)
- Test: `server/src/processes/native.test.ts:129-143`

- [ ] **Step 1: Write the failing test**

Replace the existing `describe('parsePsOutput', ...)` block in `server/src/processes/native.test.ts` with:

```ts
describe('parsePsOutput', () => {
  it('extracts pid/ppid/start/rss/comm/command', () => {
    const sample = `  PID  PPID                      LSTART    RSS COMM             COMMAND
    1     0 Thu Jun  5 09:00:00 2025   12048 launchd          /sbin/launchd
12345 12300 Thu Jun  5 10:30:15 2025  831488 node             /usr/local/bin/node /x/bin/vite
`;
    const rows = parsePsOutput(sample);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      pid: 12345, ppid: 12300, comm: 'node', rss_kb: 831488,
      command: '/usr/local/bin/node /x/bin/vite',
    });
    expect(rows[0]).toMatchObject({ pid: 1, rss_kb: 12048 });
    expect(typeof rows[1].start_ts).toBe('number');
  });

  it('skips a line whose rss column is missing rather than mis-binding comm', () => {
    const sample = `  PID  PPID                      LSTART    RSS COMM             COMMAND
    1     0 Thu Jun  5 09:00:00 2025 launchd          /sbin/launchd
`;
    expect(parsePsOutput(sample)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/processes/native.test.ts -t parsePsOutput --root server`
Expected: FAIL — `rss_kb` is undefined on the parsed rows.

- [ ] **Step 3: Implement**

In `server/src/processes/native.ts`, change the `PsRow` type (line 18) to:

```ts
export type PsRow = { pid: number; ppid: number; start_ts: number; rss_kb: number; comm: string; command: string };
```

In `parsePsOutput`, change the regex and the pushed object. The `rss` group sits between `lstart` and `comm`, so every group after it shifts by one:

```ts
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+[ \d]\d\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5] || !m[6]) continue;
    rows.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      start_ts: Date.parse(m[3]) * 1_000_000,
      rss_kb: parseInt(m[4], 10),
      comm: m[5],
      command: m[6],
    });
```

In `listProcesses`, change the `ps` argument list so the column order matches the regex:

```ts
        'ps', ['-A', '-o', 'pid,ppid,lstart,rss,comm,command'],
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/processes/native.test.ts --root server`
Expected: PASS, all cases in the file.

- [ ] **Step 5: Sanity-check the real `ps` output shape**

Run: `ps -A -o pid,ppid,lstart,rss,comm,command | head -3`
Expected: an `RSS` column of right-aligned integers between the year and the command name. If your `ps` reflows the columns differently, fix the regex before continuing — everything downstream depends on this parse.

- [ ] **Step 6: Commit**

```bash
git add server/src/processes/native.ts server/src/processes/native.test.ts
git commit -m "collect rss from ps into PsRow"
```

---

### Task 2: `rss_kb` on the broadcast `ProcessRow`

**Files:**
- Modify: `server/src/processes/reconciler.ts:8-68` (the `ProcessRow` interface), `:360` (the per-tick refresh), `:409-440` (`createRow`)
- Test: `server/src/processes/reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/processes/reconciler.test.ts`. Match the file's existing helper for building `PsRow` fixtures if one exists; otherwise use this literal:

```ts
describe('rss', () => {
  it('stamps rss_kb on a new row and refreshes it on the next tick', () => {
    const rec = new Reconciler();
    const ps = (rss: number) => [
      { pid: 4242, ppid: 1, start_ts: 1_000_000_000_000_000_000, rss_kb: rss, comm: 'node', command: '/usr/bin/node server.js' },
    ];
    const first = rec.tick(ps(120_000), 2_000, () => null);
    expect(first.upserts[0]).toMatchObject({ pid: 4242, rss_kb: 120_000 });
    const second = rec.tick(ps(180_500), 2_001, () => null);
    expect(second.upserts[0]).toMatchObject({ pid: 4242, rss_kb: 180_500 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/processes/reconciler.test.ts -t rss --root server`
Expected: FAIL — TypeScript rejects `rss_kb` on the `PsRow` literal only if Task 1 is missing; otherwise the assertion fails because `ProcessRow` has no `rss_kb`.

- [ ] **Step 3: Implement**

In `server/src/processes/reconciler.ts`, add to the `ProcessRow` interface, directly after the `uptime_s: number;` line:

```ts
  /** Resident set size in KB, resampled from `ps` on every tick. Summing
   * it across a subtree double-counts shared pages, so a tree total is an
   * upper bound — the UI says so rather than correcting it. */
  rss_kb: number;
```

In `createRow`'s returned object, next to `uptime_s: 0,`:

```ts
      rss_kb: p.rss_kb,
```

In `tick`, beside the existing `row.uptime_s` assignment (~line 360):

```ts
      row.uptime_s = nowS - p.start_ts / 1_000_000_000;
      row.rss_kb = p.rss_kb;
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm run test:server`
Expected: PASS. Other tests in `processes/` construct `PsRow` fixtures; TypeScript will flag any that now lack `rss_kb`. Add `rss_kb: 0` to each such fixture.

- [ ] **Step 5: Commit**

```bash
git add server/src/processes/reconciler.ts server/src/processes/reconciler.test.ts server/src/processes/
git commit -m "carry rss_kb onto every broadcast process row"
```

---

### Task 3: Client row type and `formatRss`

**Files:**
- Modify: `client/src/useProcesses.ts:4-48`, `client/src/lib/format.ts`
- Test: `client/src/lib/format.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `client/src/lib/format.test.ts`:

```ts
describe('formatRss', () => {
  it('renders KB below a megabyte', () => {
    expect(formatRss(0)).toBe('0 KB');
    expect(formatRss(912)).toBe('912 KB');
  });
  it('renders whole megabytes', () => {
    expect(formatRss(831488)).toBe('812 MB');
    expect(formatRss(1024)).toBe('1 MB');
  });
  it('renders gigabytes to one decimal', () => {
    expect(formatRss(5138022)).toBe('4.9 GB');
    expect(formatRss(1048576)).toBe('1.0 GB');
  });
});
```

Add `formatRss` to the existing import at the top of that file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/format.test.ts -t formatRss --root client`
Expected: FAIL with "formatRss is not a function" (or a TS resolution error).

- [ ] **Step 3: Implement**

Append to `client/src/lib/format.ts`:

```ts
/** Resident set size, KB in → a short human string. Whole MB reads better
 * than a decimal in a dense table; only GB earns a decimal place. */
export function formatRss(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${Math.round(kb)} KB`;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/lib/format.test.ts --root client`
Expected: PASS.

- [ ] **Step 5: Mirror the field on the client row type**

In `client/src/useProcesses.ts`, inside the `ProcessRow` type, next to the existing `uptime_s` field:

```ts
  /** Resident set size in KB. Mirrors the server `ProcessRow` field
   * (`processes/reconciler.ts`); both type definitions are hand-kept in
   * sync. */
  rss_kb: number;
```

- [ ] **Step 6: Commit**

```bash
git add client/src/useProcesses.ts client/src/lib/format.ts client/src/lib/format.test.ts
git commit -m "add formatRss and mirror rss_kb on the client process row"
```

---

### Task 4: The pure rollup + banner module

**Files:**
- Create: `client/src/lib/processMemory.ts`
- Test: `client/src/lib/processMemory.test.ts`

This is the whole of the feature's logic. It takes plain data — rows, a
children map, the panel map — and returns numbers. No React, no DOM.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/processMemory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow } from '../useProcesses.ts';
import { IDLE_THRESHOLDS, reclaimable, subtreeRss } from './processMemory.ts';

function row(over: Partial<ProcessRow> & { pid: number }): ProcessRow {
  return {
    process_id: `p${over.pid}`, host: 'local',
    pid: over.pid, ppid: 0, start_ts: 0,
    command: 'x', cwd: null, session_id: null,
    hook_command: null, run_in_background: false, provenance: 'observed',
    runtime: null, runtime_version: null, runtime_source: null,
    framework: null, framework_version: null,
    ports: [], ended_ts: null, ended_reason: null,
    uptime_s: 0, rss_kb: 0, bash_id: null, project: null,
    account_label: null, iterm_session_id: null, original_ancestors: [],
    ...over,
  } as ProcessRow;
}

function panel(id: string, lastEventAt: number): PanelState {
  return { id, last_event_at: lastEventAt } as unknown as PanelState;
}

/** claude(1) → mcp(2) → helper(3), plus a sibling leaf(4). */
function tree() {
  const rows = {
    root: row({ pid: 1, rss_kb: 100, session_id: 's1', runtime: 'claude' }),
    mcp: row({ pid: 2, ppid: 1, rss_kb: 800 }),
    helper: row({ pid: 3, ppid: 2, rss_kb: 200 }),
    leaf: row({ pid: 4, ppid: 1, rss_kb: 50 }),
  };
  const childrenByPid = new Map<number, ProcessRow[]>([
    [1, [rows.mcp, rows.leaf]],
    [2, [rows.helper]],
  ]);
  return { rows, childrenByPid };
}

describe('subtreeRss', () => {
  it('sums a row and every descendant', () => {
    const { rows, childrenByPid } = tree();
    expect(subtreeRss(rows.root, childrenByPid)).toBe(1150);
    expect(subtreeRss(rows.mcp, childrenByPid)).toBe(1000);
    expect(subtreeRss(rows.leaf, childrenByPid)).toBe(50);
  });

  it('terminates on a cycle instead of recursing forever', () => {
    const a = row({ pid: 1, rss_kb: 10 });
    const b = row({ pid: 2, ppid: 1, rss_kb: 20 });
    const childrenByPid = new Map<number, ProcessRow[]>([[1, [b]], [2, [a]]]);
    expect(subtreeRss(a, childrenByPid)).toBe(30);
  });
});

describe('reclaimable', () => {
  const NOW = 1_000_000;

  it('totals subtree RSS for roots idle past the threshold', () => {
    const { rows, childrenByPid } = tree();
    const panels = new Map([['s1', panel('s1', NOW - 7200)]]);
    const r = reclaimable([rows.root], childrenByPid, panels, 3600, NOW);
    expect(r.treeCount).toBe(1);
    expect(r.totalKb).toBe(1150);
    expect([...r.sessionIds]).toEqual(['s1']);
  });

  it('excludes a root idle for less than the threshold', () => {
    const { rows, childrenByPid } = tree();
    const panels = new Map([['s1', panel('s1', NOW - 60)]]);
    const r = reclaimable([rows.root], childrenByPid, panels, 3600, NOW);
    expect(r).toMatchObject({ treeCount: 0, totalKb: 0 });
    expect(r.sessionIds.size).toBe(0);
  });

  it('excludes a root with no panel rather than assuming it is idle', () => {
    const { rows, childrenByPid } = tree();
    const r = reclaimable([rows.root], childrenByPid, new Map(), 3600, NOW);
    expect(r).toMatchObject({ treeCount: 0, totalKb: 0 });
  });

  it('excludes a root with no session_id', () => {
    const { rows, childrenByPid } = tree();
    const orphan = row({ pid: 1, rss_kb: 100, runtime: 'claude' });
    const panels = new Map([['s1', panel('s1', NOW - 7200)]]);
    void rows;
    const r = reclaimable([orphan], childrenByPid, panels, 3600, NOW);
    expect(r).toMatchObject({ treeCount: 0, totalKb: 0 });
  });

  it('totals across several idle trees', () => {
    const { rows, childrenByPid } = tree();
    const second = row({ pid: 10, rss_kb: 400, session_id: 's2', runtime: 'claude' });
    const panels = new Map([
      ['s1', panel('s1', NOW - 7200)],
      ['s2', panel('s2', NOW - 90_000)],
    ]);
    const r = reclaimable([rows.root, second], childrenByPid, panels, 3600, NOW);
    expect(r.treeCount).toBe(2);
    expect(r.totalKb).toBe(1550);
  });
});

describe('IDLE_THRESHOLDS', () => {
  it('matches the buckets IdleCell already colors on', () => {
    expect(IDLE_THRESHOLDS.map((t) => t.seconds)).toEqual([300, 1800, 7200, 21600, 86400, 604800]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/processMemory.test.ts --root client`
Expected: FAIL — cannot resolve `./processMemory.ts`.

- [ ] **Step 3: Implement**

Create `client/src/lib/processMemory.ts`:

```ts
import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow } from '../useProcesses.ts';

/** Idle cutoffs offered by the reclaimable-memory banner. Deliberately the
 * same boundaries `IdleCell` buckets its colors on, so the banner's
 * threshold and the Idle column's shading never disagree. */
export const IDLE_THRESHOLDS = [
  { seconds: 300, label: '5m' },
  { seconds: 1800, label: '30m' },
  { seconds: 7200, label: '2h' },
  { seconds: 21600, label: '6h' },
  { seconds: 86400, label: '24h' },
  { seconds: 604800, label: '7d' },
] as const;

export const DEFAULT_IDLE_THRESHOLD_S = 7200;

/** Sum of `rss_kb` over a row and every descendant. The visited guard is
 * load-bearing: `childrenByPid` is built from ppid/ancestor links that can
 * form a cycle after a reparent, and without it this recurses until the
 * stack blows. */
export function subtreeRss(row: ProcessRow, childrenByPid: Map<number, ProcessRow[]>): number {
  let total = 0;
  const seen = new Set<number>();
  const stack: ProcessRow[] = [row];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    total += cur.rss_kb;
    for (const kid of childrenByPid.get(cur.pid) ?? []) stack.push(kid);
  }
  return total;
}

export type Reclaimable = {
  /** Sessions whose trees are counted — the banner's filter uses this set. */
  sessionIds: Set<string>;
  totalKb: number;
  treeCount: number;
};

/**
 * Total memory held by session trees idle past `thresholdSeconds`.
 *
 * A root with no `session_id`, or one whose session has no panel, is
 * EXCLUDED rather than treated as idle — a missing panel means brainhouse
 * has no activity record for that session (it predates the server, or is
 * unwatched), which is not the same as knowing it has been quiet.
 */
export function reclaimable(
  roots: ProcessRow[],
  childrenByPid: Map<number, ProcessRow[]>,
  panels: Map<string, PanelState>,
  thresholdSeconds: number,
  now: number,
): Reclaimable {
  const sessionIds = new Set<string>();
  let totalKb = 0;
  let treeCount = 0;
  for (const root of roots) {
    if (!root.session_id) continue;
    const panel = panels.get(root.session_id);
    if (!panel) continue;
    if (now - panel.last_event_at < thresholdSeconds) continue;
    sessionIds.add(root.session_id);
    totalKb += subtreeRss(root, childrenByPid);
    treeCount++;
  }
  return { sessionIds, totalKb, treeCount };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/lib/processMemory.test.ts --root client`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/processMemory.ts client/src/lib/processMemory.test.ts
git commit -m "add subtree RSS rollup and reclaimable-tree derivation"
```

---

### Task 5: The RSS column

**Files:**
- Modify: `client/src/components/ProcessesPanel.tsx:17` (`SortKey`), `:22-43` (`sortValue`), the `<thead>` around `:640-647`, the `rows.map` at `:657`
- Modify: `client/src/components/ProcessRow.tsx:100/138` (props), `:483-484` (cells)
- Modify: `client/src/components/ProcessesPanel.test.tsx:20-45` (fixture)
- Modify: `client/src/app.css`

- [ ] **Step 1: Write the failing test**

First add `rss_kb: 831488,` to `FIXTURE_ROW` in `client/src/components/ProcessesPanel.test.tsx` (next to `uptime_s: 724,`). Then append this test inside the existing `describe('ProcessesPanel', ...)`:

```ts
  it('shows an RSS column with the row footprint', async () => {
    render(<ProcessesPanel allPanels={new Map()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /network/i }));
    expect(screen.getByText('812 MB')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /rss/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/components/ProcessesPanel.test.tsx -t "RSS column" --root client`
Expected: FAIL — no element with text `812 MB`.

- [ ] **Step 3: Implement the cell in `ProcessRow.tsx`**

Add the import at the top of `client/src/components/ProcessRow.tsx` (merge into the existing `../lib/format.ts` import if there is one):

```ts
import { formatRss } from '../lib/format.ts';
```

Add two props to the component's destructured parameters (near `showIdle = false,`) and to its props type (near `showIdle?: boolean;`):

```ts
  rssKb,
  rssIsSubtree = false,
```

```ts
  /** RSS to display for this row. A collapsed root shows its subtree
   * total; anything else shows its own. Defaults to the row's own value. */
  rssKb?: number;
  rssIsSubtree?: boolean;
```

Insert the cell between the Idle cell and the Uptime cell (currently lines 483-484):

```tsx
        {showIdle && <IdleCell panel={panel} />}
        <td
          className={rssIsSubtree ? 'process-rss process-rss-subtree' : 'process-rss'}
          title={
            rssIsSubtree
              ? 'resident memory summed over this tree — an upper bound, since shared pages are counted once per process'
              : 'resident memory for this process'
          }
        >
          {formatRss(rssKb ?? row.rss_kb)}
        </td>
        <td>{fmtUptime(row.uptime_s)}</td>
```

- [ ] **Step 4: Implement the column in `ProcessesPanel.tsx`**

Extend the sort key type (line 17):

```ts
type SortKey = 'pid' | 'project' | 'account' | 'command' | 'session' | 'idle' | 'uptime' | 'rss' | null;
```

Add a case to `sortValue`, before `case 'uptime':`:

```ts
    case 'rss':
      return row.rss_kb;
```

Add the header between the Idle and Uptime `SortHeader`s in the `<thead>`:

```tsx
                <SortHeader
                  label="RSS"
                  sortKey="rss"
                  sort={sort}
                  toggle={toggleSort}
                  width="80px"
                />
```

Sorting a root by `rss` sorts on the root's own footprint, which for a
`claude` process is small and misleading. Sort roots on their subtree
total instead. In the sessions branch, after `const { childrenByPid } = buildParentLinks(inSessionTree);`
and after `roots` has been finalized (immediately before the
`if (sort.key)` block), add:

```ts
    const subtreeRssByPid = new Map<number, number>();
    for (const r of roots) subtreeRssByPid.set(r.pid, subtreeRss(r, childrenByPid));
```

Change the sessions-branch comparator to prefer that total when sorting by RSS:

```ts
      roots = roots.slice().sort((a, b) => {
        const pa = a.session_id ? (allPanels.get(a.session_id) ?? null) : null;
        const pb = b.session_id ? (allPanels.get(b.session_id) ?? null) : null;
        if (k === 'rss') {
          return cmp(subtreeRssByPid.get(a.pid) ?? 0, subtreeRssByPid.get(b.pid) ?? 0, sort.dir);
        }
        return cmp(sortValue(a, pa, k, nowForSort), sortValue(b, pb, k, nowForSort), sort.dir);
      });
```

Carry the total onto the display entries. In the sessions branch's
`display = flattenTree(...).map(...)`, add one field to the mapped object:

```ts
      rssKb:
        n.depth === 0 && !expandedRoots.has(n.row.pid)
          ? (subtreeRssByPid.get(n.row.pid) ?? n.row.rss_kb)
          : n.row.rss_kb,
```

Widen the `display` declaration to allow it:

```ts
  let display: Array<{
    row: Row;
    depth: number;
    hasChildren?: boolean;
    isRoot?: boolean;
    preferCommand?: boolean;
    rssKb?: number;
  }>;
```

Thread it through the `rows.map` in the JSX — change the destructure and add the props:

```tsx
              {rows.map(({ row, depth, hasChildren, isRoot, preferCommand, rssKb }) => (
```

```tsx
                  rssKb={rssKb}
                  rssIsSubtree={rssKb !== undefined && rssKb !== row.rss_kb}
```

Add the import:

```ts
import { subtreeRss } from '../lib/processMemory.ts';
```

- [ ] **Step 5: Style it**

Append to `client/src/app.css`:

```css
.process-rss {
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.process-rss-subtree {
  font-style: italic;
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npm run test:client`
Expected: PASS. Any other client test constructing a `ProcessRow` fixture will fail typecheck without `rss_kb` — add `rss_kb: 0` to each.

- [ ] **Step 7: Verify in the running app**

The watch service rebuilds automatically. Confirm the redeploy landed:

Run: `tail -20 ~/Library/Logs/brainhouse/stdout.log | grep watch-service`
Then open the dashboard, show the top widget in Sessions view, and confirm: an RSS column, collapsed roots showing an italic subtree total, expanding a root switching its children to their own values, and the RSS header sorting biggest-tree-first on first click.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/ProcessRow.tsx client/src/components/ProcessesPanel.tsx client/src/components/ProcessesPanel.test.tsx client/src/app.css
git commit -m "show an RSS column with per-tree rollup in the top widget"
```

---

### Task 6: The server-loss warning glyph

**Files:**
- Create: `client/src/assets/icons/serving.svg`
- Modify: `client/src/components/ProcessRow.tsx:485-505` (the actions cell)
- Modify: `client/src/components/ProcessesPanel.tsx:337-341` (`killSelected`), `:498-506` (the batch button)
- Modify: `client/src/app.css`
- Test: `client/src/components/ProcessesPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Append inside `describe('ProcessesPanel', ...)` in `client/src/components/ProcessesPanel.test.tsx`:

```ts
  it('warns that a checked row is serving a port', async () => {
    render(<ProcessesPanel allPanels={new Map()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /network/i }));
    // The fixture binds :5173.
    expect(screen.getByLabelText(/serving a listening port/i)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select PID 100' }));
    expect(screen.getByRole('button', { name: /kill 1 selected/i })).toHaveTextContent('1 serving');
  });

  it('omits the serving warning for a row with no ports', async () => {
    // Sessions view: a claude row is a tree root whether or not it binds a
    // port, so it can carry the negative assertion Network view
    // structurally cannot (`isNetwork` requires a non-inherited port).
    mock.rows = [{ ...FIXTURE_ROW, runtime: 'claude', command: 'claude', ports: [] }];
    render(<ProcessesPanel allPanels={new Map()} />);
    // Earlier tests may have persisted viewMode=network; pick Sessions explicitly.
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /sessions/i }));
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.queryByLabelText(/serving a listening port/i)).not.toBeInTheDocument();
  });
```

Accessible names used above are the ones the components already render:
`ProcessRow.tsx:202` labels the row checkbox `Select PID ${row.pid}`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/components/ProcessesPanel.test.tsx -t serving --root client`
Expected: FAIL — no element labeled "serving a listening port".

- [ ] **Step 3: Create the icon**

Create `client/src/assets/icons/serving.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M2 2h12v4H2V2zm1.5 1.5v1h1v-1h-1zM2 10h12v4H2v-4zm1.5 1.5v1h1v-1h-1z" />
  <path d="M7.25 6h1.5v4h-1.5z" />
</svg>
```

- [ ] **Step 4: Render the glyph**

In `client/src/components/ProcessRow.tsx`, add the import beside the existing icon import:

```ts
import servingIcon from '../assets/icons/serving.svg?raw';
```

In the actions cell, immediately before the kill `<button>`:

```tsx
          {row.ports.length > 0 && (
            <span
              className="process-serving-warning"
              role="img"
              aria-label={`PID ${row.pid} is serving a listening port — killing it takes the server down`}
              title="Serving a listening port. Killing this takes the server down."
            >
              <SvgGlyph svg={servingIcon} className="svg-glyph" />
            </span>
          )}
          <button onClick={kill} aria-label={`Kill PID ${row.pid}`}>
```

- [ ] **Step 5: Count servers in the batch button**

In `client/src/components/ProcessesPanel.tsx`, after the `liveSelected` line:

```ts
  const servingSelected = liveSelected.filter(
    (id) => (all.find((r) => r.process_id === id)?.ports.length ?? 0) > 0,
  ).length;
```

Change the batch button's label and title:

```tsx
              title="Kill every checked process (same per-row ✕ kill, batched)"
              onClick={killSelected}
            >
              kill {liveSelected.length} selected
              {servingSelected > 0 ? ` — ${servingSelected} serving` : ''}
            </button>
```

- [ ] **Step 6: Style it**

Append to `client/src/app.css`:

```css
.process-serving-warning {
  color: var(--warn, #d08a2a);
  display: inline-flex;
  align-items: center;
}
```

If `--warn` is not defined in the theme, use the nearest existing
warning/attention custom property in `app.css` rather than inventing one.

- [ ] **Step 7: Run the tests and make sure they pass**

Run: `npm run test:client`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/assets/icons/serving.svg client/src/components/ProcessRow.tsx client/src/components/ProcessesPanel.tsx client/src/components/ProcessesPanel.test.tsx client/src/app.css
git commit -m "warn when killing a process would take a listening server down"
```

---

### Task 7: The reclaimable-memory banner

**Files:**
- Modify: `client/src/components/ProcessesPanel.tsx` — new localStorage keys near `:12-14`, state near `:275-295`, the banner in the `<header>` near `:487`, the sessions-branch filter
- Modify: `client/src/app.css`
- Test: `client/src/components/ProcessesPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Append inside `describe('ProcessesPanel', ...)` in `client/src/components/ProcessesPanel.test.tsx`:

```ts
  it('totals memory under sessions idle past the threshold and filters to them', async () => {
    const now = Date.now() / 1000;
    mock.rows = [
      { ...FIXTURE_ROW, process_id: 'c1', pid: 200, ppid: 1, runtime: 'claude',
        command: 'claude', session_id: 'idle-1', ports: [], rss_kb: 100_000 },
      { ...FIXTURE_ROW, process_id: 'm1', pid: 201, ppid: 200, runtime: 'node',
        command: 'npx @playwright/mcp', session_id: 'idle-1', ports: [], rss_kb: 900_000 },
      { ...FIXTURE_ROW, process_id: 'c2', pid: 300, ppid: 1, runtime: 'claude',
        command: 'claude', session_id: 'busy-1', ports: [], rss_kb: 100_000 },
    ];
    const panels = new Map([
      ['idle-1', { id: 'idle-1', last_event_at: now - 10_000 } as unknown as PanelState],
      ['busy-1', { id: 'busy-1', last_event_at: now - 5 } as unknown as PanelState],
    ]);
    render(<ProcessesPanel allPanels={panels} />);
    const banner = screen.getByRole('button', { name: /reclaimable/i });
    // 1,000,000 KB across one tree.
    expect(banner).toHaveTextContent('977 MB');
    expect(banner).toHaveTextContent('1 tree');

    const user = userEvent.setup();
    await user.click(banner);
    expect(screen.getByText('200')).toBeInTheDocument(); // idle session's pid
    expect(screen.queryByText('300')).not.toBeInTheDocument(); // busy session gone
  });

  it('hides the banner when nothing is idle past the threshold', () => {
    const now = Date.now() / 1000;
    mock.rows = [
      { ...FIXTURE_ROW, process_id: 'c2', pid: 300, ppid: 1, runtime: 'claude',
        command: 'claude', session_id: 'busy-1', ports: [], rss_kb: 100_000 },
    ];
    const panels = new Map([
      ['busy-1', { id: 'busy-1', last_event_at: now - 5 } as unknown as PanelState],
    ]);
    render(<ProcessesPanel allPanels={panels} />);
    expect(screen.queryByRole('button', { name: /reclaimable/i })).not.toBeInTheDocument();
  });
```

Add `import type { PanelState } from '../useDeltaStream.ts';` to the test file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/components/ProcessesPanel.test.tsx -t reclaimable --root client`
Expected: FAIL — no button named /reclaimable/.

- [ ] **Step 3: Implement**

Add the imports:

```ts
import { formatRss } from '../lib/format.ts';
import {
  DEFAULT_IDLE_THRESHOLD_S,
  IDLE_THRESHOLDS,
  reclaimable,
  subtreeRss,
} from '../lib/processMemory.ts';
```

Add the localStorage keys beside the existing three:

```ts
const IDLE_THRESHOLD_KEY = 'brainhouse:processes:reclaimThresholdS';
```

Add state beside the other view prefs (following the same try/catch idiom
the file already uses — `preferences.ts` holds only body-class booleans and
is not the right home for this):

```ts
  const [reclaimThresholdS, setReclaimThresholdS] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(IDLE_THRESHOLD_KEY));
      return IDLE_THRESHOLDS.some((t) => t.seconds === saved) ? saved : DEFAULT_IDLE_THRESHOLD_S;
    } catch {
      return DEFAULT_IDLE_THRESHOLD_S;
    }
  });
  /** When on, the sessions tree is narrowed to the trees the banner counted. */
  const [reclaimFilterOn, setReclaimFilterOn] = useState(false);
```

Persist it alongside the other prefs:

```ts
  useEffect(() => {
    try {
      localStorage.setItem(IDLE_THRESHOLD_KEY, String(reclaimThresholdS));
    } catch {}
  }, [reclaimThresholdS]);
```

In the sessions branch, after `subtreeRssByPid` is built (Task 5), compute
the banner and apply its filter. Declare `reclaim` above the
`if (viewMode === 'sessions')` block so the header can read it:

```ts
  let reclaim: { sessionIds: Set<string>; totalKb: number; treeCount: number } = {
    sessionIds: new Set(),
    totalKb: 0,
    treeCount: 0,
  };
```

Inside the sessions branch, right after `subtreeRssByPid`:

```ts
    reclaim = reclaimable(roots, childrenByPid, allPanels, reclaimThresholdS, nowForSort);
    if (reclaimFilterOn) {
      roots = roots.filter((r) => r.session_id !== null && reclaim.sessionIds.has(r.session_id));
    }
```

Render the banner as the first child of the `<header>`, above the `<h2>`:

```tsx
        {viewMode === 'sessions' && reclaim.treeCount > 0 && (
          <div className="processes-reclaim">
            <button
              type="button"
              className={
                reclaimFilterOn ? 'processes-reclaim-total is-filtering' : 'processes-reclaim-total'
              }
              aria-pressed={reclaimFilterOn}
              title="Resident memory summed across sessions idle past the threshold. Click to narrow the list to those trees; summed RSS double-counts shared pages, so this is an upper bound."
              onClick={() => setReclaimFilterOn((v) => !v)}
            >
              {formatRss(reclaim.totalKb)} reclaimable in {reclaim.treeCount}{' '}
              {reclaim.treeCount === 1 ? 'tree' : 'trees'}
            </button>
            <label className="processes-reclaim-threshold">
              idle over
              <select
                value={reclaimThresholdS}
                onChange={(e) => setReclaimThresholdS(Number(e.target.value))}
              >
                {IDLE_THRESHOLDS.map((t) => (
                  <option key={t.seconds} value={t.seconds}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
```

Turn the filter off when it would strand the user on an empty list — add
beside the other effects:

```ts
  useEffect(() => {
    if (reclaimFilterOn && reclaim.treeCount === 0) setReclaimFilterOn(false);
  }, [reclaimFilterOn, reclaim.treeCount]);
```

- [ ] **Step 4: Style it**

Append to `client/src/app.css`:

```css
.processes-reclaim {
  display: flex;
  align-items: center;
  gap: 0.5em;
  font-size: 0.85em;
}
.processes-reclaim-total {
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.processes-reclaim-total.is-filtering {
  outline: 1px solid currentColor;
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm run test:client`
Expected: PASS.

- [ ] **Step 6: Verify in the running app**

Open the dashboard's top widget in Sessions view. On this machine there
are real long-idle MCP trees, so the banner should show several GB.
Confirm: clicking it narrows the tree list; clicking again restores it;
changing the threshold select changes the total and survives a reload.

Do NOT kill anything as part of verification.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/ProcessesPanel.tsx client/src/components/ProcessesPanel.test.tsx client/src/app.css
git commit -m "add a reclaimable-memory banner for long-idle session trees"
```

---

### Task 8: Record the behavior rules

**Files:**
- Modify: `docs/assertions.md`

- [ ] **Step 1: Append the rules**

Match the file's existing formatting. Add:

```markdown
- Every process row carries `rss_kb`, resampled from `ps` each tick. A
  collapsed session root displays its subtree total instead of its own
  footprint; expanding it shows each process's own. Summed RSS
  double-counts shared pages, so a tree total is an upper bound.
- The top widget's reclaimable banner counts session trees whose panel has
  been idle past the selected threshold. A session with no panel is
  excluded, not assumed idle.
- brainhouse never kills a process on its own. Any row serving a listening
  port (directly or via a descendant) shows a warning glyph, and the batch
  kill button names how many of the checked rows are serving.
```

- [ ] **Step 2: Lint and run everything**

Run: `npm test`
Expected: all suites pass (server, client, bin).

Then lint only what this feature touched:
Run: `npx biome check server/src/processes client/src/lib/processMemory.ts client/src/lib/format.ts client/src/components/ProcessRow.tsx client/src/components/ProcessesPanel.tsx`
Expected: no NEW errors attributable to this branch.

- [ ] **Step 3: Commit**

```bash
git add docs/assertions.md
git commit -m "record process memory accounting behavior rules"
```

---

## Verification checklist

Before calling this done, confirm each with actual output — not inference:

- [ ] `npm test` passes end to end (server, client, bin).
- [ ] `npx biome check` on the touched paths reports no new errors.
- [ ] `~/Library/Logs/brainhouse/stdout.log` shows the `[watch-service]` rebuild for both the server and client changes.
- [ ] In the live dashboard: RSS column sorts, collapsed roots roll up, the banner shows a nonzero total, its filter narrows the list, and a port-binding row shows the warning glyph.
