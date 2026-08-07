# Awaiting-Input Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS notifications when a session waits for input past a grace window; clicking raises the iTerm window without stealing focus.

**Architecture:** Server-side `AlertQueue` owns all decisions (prefs, grace timing, dedupe, expiry) and exposes plain HTTP routes; the Swift menubar helper (repackaged as a `.app` bundle for `UNUserNotificationCenter`) polls, posts, and reports clicks. Reveal gains a no-focus `AXRaise` variant.

**Tech Stack:** TypeScript (fastify + zod + vitest fake timers), Swift (AppKit + UserNotifications), AppleScript via osascript.

**Spec:** `docs/superpowers/specs/2026-08-06-awaiting-input-alerts-design.md`

---

## File map

- Create: `server/src/alertQueue.ts` — pure alert-decision logic (grace, dedupe, expiry, cursor list)
- Create: `server/src/alertQueue.test.ts`
- Modify: `server/src/prefs.ts` — extend `NotificationsSchema`
- Modify: `server/src/monitor.ts` — construct + wire AlertQueue
- Modify: `server/src/monitor.test.ts` — wiring tests
- Modify: `server/src/processes/native.ts` — no-focus reveal script
- Modify: `server/src/processes/index.ts` — pass `focus` through
- Modify: `server/src/trpc.ts` — optional `focus` on `revealInIterm`
- Modify: `server/src/index.ts` — `/api/alerts`, `/api/reveal`, `/api/notifications`
- Modify: `client/src/lib/useAwaitingNotifications.ts` — honor `muteAll`
- Modify: `client/src/components/PrefsModal.tsx` — new notification prefs fields
- Modify: `menubar/main.swift` — notifications, click handler, menu toggle
- Modify: `scripts/install-menubar.sh` — `.app` bundle packaging
- Modify: `docs/assertions.md` — behavior rules

---

### Task 1: Prefs schema additions

**Files:** Modify `server/src/prefs.ts` (NotificationsSchema, ~line 215)

- [ ] **Step 1: Extend the schema**

Append to `NotificationsSchema` (keep the three existing fields):

```ts
  /** Master mute. Gates every channel — the server-side AlertQueue stops
   * enqueuing and the client channels (tab flash, browser toast, chime)
   * skip firing. Flipped from the menubar helper's menu toggle or the
   * prefs modal. */
  muteAll: z.boolean().default(false),
  /** macOS Notification Center channel, delivered by the menu bar
   * helper. Fires when a session has been awaiting input past
   * `graceSeconds`. */
  macNative: z.boolean().default(true),
  /** Also alert (immediately, no grace) when a session's turn completes
   * (Stop hook). Off by default — the blocked state is the time sink. */
  macNativeTurnComplete: z.boolean().default(false),
  /** Seconds a session must stay awaiting before the native alert
   * enqueues. 0 = immediate. Waits answered inside the window never
   * notify. */
  graceSeconds: z.number().int().min(0).default(30),
  /** When true, clicking a notification focuses iTerm (activate). When
   * false (default), the window is raised via AXRaise without taking
   * keyboard focus. */
  clickFocus: z.boolean().default(false),
```

- [ ] **Step 2: Verify schema defaults parse**

Run: `npx vitest run src/prefs.test.ts` (from `server/`; root: `npm run test:server`)
Expected: PASS (existing tests exercise `PrefsSchema.parse({})` — new defaults must not break them)

- [ ] **Step 3: Commit**

```bash
git add server/src/prefs.ts
git commit -m "feat(prefs): notification channel prefs for native alerts (muteAll, macNative, grace, clickFocus)"
```

### Task 2: AlertQueue

**Files:** Create `server/src/alertQueue.ts`, `server/src/alertQueue.test.ts`

- [ ] **Step 1: Write failing tests**

`server/src/alertQueue.test.ts` — reuse the FakeTimers pattern from `titler.test.ts` (copy the class; it's 30 lines) and a `makePanel` helper (copy from `titler.test.ts`, it builds a full `Panel`):

```ts
import { describe, expect, it } from 'vitest';
import { AlertQueue } from './alertQueue.js';
import type { Panel } from './session.js';

// FakeTimers: copy verbatim from titler.test.ts (setTimer/clearTimer/now/advance).
// makePanel: copy from titler.test.ts; it already includes awaiting_input,
// title, repo_root, cwd, account_label, iterm_session_id fields.

function defaultPrefs() {
  return { muteAll: false, macNative: true, macNativeTurnComplete: false, graceSeconds: 30 };
}

function build(opts: { panels: Map<string, Panel>; prefs?: () => ReturnType<typeof defaultPrefs>; timers: FakeTimers }) {
  return new AlertQueue({
    getPanel: (id) => opts.panels.get(id),
    getNotificationPrefs: opts.prefs ?? defaultPrefs,
    now: opts.timers.now,
    setTimer: opts.timers.setTimer,
    clearTimer: opts.timers.clearTimer,
  });
}

describe('AlertQueue', () => {
  it('enqueues after the grace window when still awaiting', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true, title: 'T', iterm_session_id: 'GUID-1' });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    expect(q.list(-1)).toHaveLength(0);
    timers.advance(30_000);
    const alerts = q.list(-1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ panel_id: panel.id, reason: 'awaiting', iterm_session_id: 'GUID-1' });
  });

  it('never fires when the wait clears inside the grace window', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    panel.awaiting_input = false; // answered
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(0);
  });

  it('graceSeconds 0 enqueues immediately', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({
      panels: new Map([[panel.id, panel]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(panel.id, true);
    expect(q.list(-1)).toHaveLength(1);
  });

  it('dedupes within one wait episode, re-alerts on a new episode', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    q.onAwaiting(panel.id, true); // duplicate transition
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(1);
    // Episode ends, new one begins.
    panel.awaiting_input = false;
    q.onAwaiting(panel.id, false);
    panel.awaiting_input = true;
    q.onAwaiting(panel.id, true);
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(2);
  });

  it('clearing the wait drops an undelivered queued alert', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(1);
    panel.awaiting_input = false;
    q.onAwaiting(panel.id, false);
    expect(q.list(-1)).toHaveLength(0);
  });

  it('list prunes awaiting alerts whose panel stopped awaiting (read-time)', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    timers.advance(30_000);
    panel.awaiting_input = false; // cleared via transcript activity, no onAwaiting(false) call
    expect(q.list(-1)).toHaveLength(0);
  });

  it('turn_complete fires immediately when the pref is on, never when off', () => {
    const timers = new FakeTimers();
    const panel = makePanel({});
    const panels = new Map([[panel.id, panel]]);
    const off = build({ panels, timers });
    off.onStop(panel.id);
    expect(off.list(-1)).toHaveLength(0);
    const on = build({
      panels,
      prefs: () => ({ ...defaultPrefs(), macNativeTurnComplete: true }),
      timers,
    });
    on.onStop(panel.id);
    expect(on.list(-1)).toMatchObject([{ reason: 'turn_complete' }]);
  });

  it('muteAll and macNative-off suppress enqueue', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const panels = new Map([[panel.id, panel]]);
    for (const prefs of [
      () => ({ ...defaultPrefs(), muteAll: true }),
      () => ({ ...defaultPrefs(), macNative: false }),
    ]) {
      const q = build({ panels, prefs, timers });
      q.onAwaiting(panel.id, true);
      timers.advance(30_000);
      expect(q.list(-1)).toHaveLength(0);
    }
  });

  it('cursor pagination: list(after) returns only newer ids', () => {
    const timers = new FakeTimers();
    const p1 = makePanel({ id: 'p1', awaiting_input: true });
    const p2 = makePanel({ id: 'p2', awaiting_input: true });
    const q = build({
      panels: new Map([[p1.id, p1], [p2.id, p2]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(p1.id, true);
    const first = q.list(-1);
    expect(first).toHaveLength(1);
    q.onAwaiting(p2.id, true);
    const newer = q.list(first[0]!.id);
    expect(newer).toHaveLength(1);
    expect(newer[0]!.panel_id).toBe('p2');
  });

  it('alerts expire after 10 minutes', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({
      panels: new Map([[panel.id, panel]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(panel.id, true);
    timers.advance(10 * 60_000 + 1_000);
    expect(q.list(-1)).toHaveLength(0);
  });

  it('project falls back cwd basename when repo_root is null', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true, repo_root: null, cwd: '/Users/x/src/myproj' });
    const q = build({
      panels: new Map([[panel.id, panel]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(panel.id, true);
    expect(q.list(-1)[0]!.project).toBe('myproj');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:server` (or `npx vitest run src/alertQueue.test.ts` from `server/`)
Expected: FAIL — `Cannot find module './alertQueue.js'`

- [ ] **Step 3: Implement**

`server/src/alertQueue.ts`:

```ts
/**
 * Server-side alert decisions for the macOS notification channel.
 *
 * The menubar helper is a dumb delivery arm — it polls `/api/alerts`,
 * posts whatever it's handed, and reports clicks. Everything else lives
 * here: the grace window (an awaiting panel only alerts if still
 * awaiting when the timer fires), per-episode dedupe, wait-clear
 * cancellation, turn-complete triggering, and expiry.
 *
 * Cancellation is validation, not plumbing: awaiting can clear from
 * transcript activity without any hook reaching this module, so both
 * fire-time and list-time re-check `panel.awaiting_input` instead of
 * relying on an explicit cancel call.
 */
import path from 'node:path';
import type { Panel } from './session.js';

export interface Alert {
  id: number;
  panel_id: string;
  title: string;
  project: string | null;
  account: string | null;
  iterm_session_id: string | null;
  reason: 'awaiting' | 'turn_complete';
  /** Unix seconds. */
  ts: number;
}

export interface AlertNotificationPrefs {
  muteAll: boolean;
  macNative: boolean;
  macNativeTurnComplete: boolean;
  graceSeconds: number;
}

export interface AlertQueueOptions {
  getPanel: (panelId: string) => Panel | undefined;
  /** Read fresh on every decision so runtime pref flips apply. */
  getNotificationPrefs: () => AlertNotificationPrefs;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const EXPIRY_MS = 10 * 60_000;

export class AlertQueue {
  private readonly opts: AlertQueueOptions;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private nextId = 1;
  private alerts: Alert[] = [];
  private readonly pendingTimers = new Map<string, unknown>();

  constructor(opts: AlertQueueOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  onAwaiting(panelId: string, awaiting: boolean): void {
    if (!awaiting) {
      const t = this.pendingTimers.get(panelId);
      if (t !== undefined) {
        this.clearTimer(t);
        this.pendingTimers.delete(panelId);
      }
      this.alerts = this.alerts.filter(
        (a) => !(a.panel_id === panelId && a.reason === 'awaiting'),
      );
      return;
    }
    const prefs = this.opts.getNotificationPrefs();
    if (prefs.muteAll || !prefs.macNative) return;
    // One alert per wait episode: a pending timer or an already-queued
    // live alert for this panel means this transition is a duplicate.
    if (this.pendingTimers.has(panelId)) return;
    if (this.alerts.some((a) => a.panel_id === panelId && a.reason === 'awaiting')) return;
    const graceMs = prefs.graceSeconds * 1000;
    if (graceMs <= 0) {
      this.fire(panelId, 'awaiting');
      return;
    }
    const timer = this.setTimer(() => {
      this.pendingTimers.delete(panelId);
      this.fire(panelId, 'awaiting');
    }, graceMs);
    this.pendingTimers.set(panelId, timer);
  }

  onStop(panelId: string): void {
    const prefs = this.opts.getNotificationPrefs();
    if (prefs.muteAll || !prefs.macNative || !prefs.macNativeTurnComplete) return;
    this.fire(panelId, 'turn_complete');
  }

  /** Alerts strictly newer than `after`, expiry- and validity-pruned. */
  list(after: number): Alert[] {
    const cutoff = this.now() - EXPIRY_MS;
    this.alerts = this.alerts.filter((a) => {
      if (a.ts * 1000 < cutoff) return false;
      if (a.reason === 'awaiting' && !this.opts.getPanel(a.panel_id)?.awaiting_input) return false;
      return true;
    });
    return this.alerts.filter((a) => a.id > after);
  }

  /** Drop pending state for a reaped panel. Idempotent. */
  dispose(panelId: string): void {
    const t = this.pendingTimers.get(panelId);
    if (t !== undefined) {
      this.clearTimer(t);
      this.pendingTimers.delete(panelId);
    }
    this.alerts = this.alerts.filter((a) => a.panel_id !== panelId);
  }

  private fire(panelId: string, reason: Alert['reason']): void {
    const prefs = this.opts.getNotificationPrefs();
    if (prefs.muteAll || !prefs.macNative) return;
    const panel = this.opts.getPanel(panelId);
    if (!panel) return;
    if (reason === 'awaiting' && !panel.awaiting_input) return; // answered during grace
    const projectPath = panel.repo_root ?? panel.cwd;
    this.alerts.push({
      id: this.nextId++,
      panel_id: panelId,
      title: panel.title,
      project: projectPath ? path.basename(projectPath) : null,
      account: panel.account_label,
      iterm_session_id: panel.iterm_session_id ?? null,
      reason,
      ts: this.now() / 1000,
    });
  }
}
```

Note: if `Panel` has no `iterm_session_id` field in its type (it's stamped by `store.setItermSessionId`), check `server/src/session.ts` for the actual field name and use that; fall back to `null` when absent.

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test:server`
Expected: alertQueue.test.ts PASS (pre-existing watcher-timing failures in watchBackend/hookEvents are environmental — ignore)

- [ ] **Step 5: Commit**

```bash
git add server/src/alertQueue.ts server/src/alertQueue.test.ts
git commit -m "feat(alerts): AlertQueue — grace-window alert decisions for native notifications"
```

### Task 3: Wire AlertQueue into the monitor

**Files:** Modify `server/src/monitor.ts`, `server/src/monitor.test.ts`

- [ ] **Step 1: Write failing test** (monitor.test.ts, near the applyHookEvent tests ~line 110)

```ts
  it('applyHookEvent notification enqueues an alert after the grace window', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({ ts: new Date().toISOString() }));
    monitor.applyHookEvent({ session_id: 'S', kind: 'notification', ts: 0 });
    // graceSeconds default is 30 — nothing yet.
    expect(monitor.alertQueue.list(-1)).toHaveLength(0);
  });
```

(A full timer-driven test lives in alertQueue.test.ts; here we only assert the wiring exists and respects grace. `newMonitor` constructs `TranscriptMonitor` directly — no prefs plumbing needed since the default `getNotificationPrefs` fallback is used.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:server`
Expected: FAIL — `monitor.alertQueue` undefined

- [ ] **Step 3: Implement wiring** in `server/src/monitor.ts`

Constructor (next to the titler construction, ~line 145). Add an injectable prefs read mirroring `isAutoTitleEnabled`:

```ts
    const getNotificationPrefs =
      opts.getNotificationPrefs ??
      (() => ({ muteAll: false, macNative: true, macNativeTurnComplete: false, graceSeconds: 30 }));
    this.alertQueue = new AlertQueue({
      getPanel: (panelId) => this.store.panel(panelId),
      getNotificationPrefs,
    });
```

Public readonly field: `readonly alertQueue: AlertQueue;` and `getNotificationPrefs?: () => AlertNotificationPrefs;` added to the monitor's options interface. Imports: `import { AlertQueue, type AlertNotificationPrefs } from './alertQueue.js';`

In `applyHookEvent`:
- `notification` branch: after `setAwaiting`, add `this.alertQueue.onAwaiting(sid, true);`
- `stop` branch: add `this.alertQueue.onStop(sid);` (after the titler call)

Where the titler is disposed on panel reap (~line 785, `this.titler.dispose(...)`): add `this.alertQueue.dispose(...)` with the same panel id.

In `server/src/index.ts` where `TranscriptMonitor` is constructed (search `new TranscriptMonitor`), pass:

```ts
    getNotificationPrefs: () => {
      const n = prefs.get().notifications;
      return {
        muteAll: n.muteAll,
        macNative: n.macNative,
        macNativeTurnComplete: n.macNativeTurnComplete,
        graceSeconds: n.graceSeconds,
      };
    },
```

(Match the existing `isAutoTitleEnabled` wiring pattern at the same construction site; `prefs` may be named differently there — follow the local name.)

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test:server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/monitor.ts server/src/monitor.test.ts server/src/index.ts
git commit -m "feat(alerts): wire AlertQueue into hook-event lifecycle"
```

### Task 4: No-focus reveal

**Files:** Modify `server/src/processes/native.ts`, `server/src/processes/index.ts`, `server/src/trpc.ts`; create test additions in `server/src/processes/native.test.ts` if present (else add script-shape asserts to a new small test file `server/src/processes/reveal.test.ts`)

- [ ] **Step 1: Write failing test** (`server/src/processes/reveal.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { ITERM_REVEAL_SCRIPT_FOCUS, ITERM_REVEAL_SCRIPT_NOFOCUS } from './native.js';

describe('iTerm reveal scripts', () => {
  it('focus variant activates; no-focus variant raises via AXRaise instead', () => {
    expect(ITERM_REVEAL_SCRIPT_FOCUS).toContain('activate');
    expect(ITERM_REVEAL_SCRIPT_NOFOCUS).not.toContain('activate');
    expect(ITERM_REVEAL_SCRIPT_NOFOCUS).toContain('AXRaise');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:server`
Expected: FAIL — exports not found

- [ ] **Step 3: Implement** in `server/src/processes/native.ts`

Rename the existing `ITERM_REVEAL_SCRIPT` const to `ITERM_REVEAL_SCRIPT_FOCUS` and export it. Add:

```ts
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
```

Change the function signature:

```ts
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
```

`server/src/processes/index.ts` (~line 266): `async revealIterm(guid: string, opts: { focus?: boolean } = {}): Promise<boolean> { return revealItermSession(guid, opts); }`

`server/src/trpc.ts` (~line 173): input gains `focus: z.boolean().optional()`; call `ctx.tracker.revealIterm(input.iterm_session_id, { focus: input.focus ?? true })`. Dashboard callers keep focusing behavior with no change.

- [ ] **Step 4: Run tests, verify pass** — `npm run test:server`

- [ ] **Step 5: Commit**

```bash
git add server/src/processes/native.ts server/src/processes/index.ts server/src/processes/reveal.test.ts server/src/trpc.ts
git commit -m "feat(reveal): no-focus variant — AXRaise the iTerm window without activate"
```

### Task 5: HTTP routes for the helper

**Files:** Modify `server/src/index.ts` (next to `/api/summary`, ~line 90)

- [ ] **Step 1: Implement routes** (no fastify inject harness exists in this repo — these three thin routes are covered by AlertQueue unit tests + the end-to-end smoke in Task 8)

```ts
  // Alert feed for the menu bar helper: cursor-paginated by monotonic id.
  // `enabled` mirrors the notification prefs so the helper's menu toggle
  // renders current state without a second endpoint.
  app.get<{ Querystring: { after?: string } }>('/api/alerts', async (req) => {
    const parsed = Number(req.query.after ?? -1);
    const after = Number.isFinite(parsed) ? parsed : -1;
    const n = prefs.get().notifications;
    return { enabled: !n.muteAll && n.macNative, alerts: monitor.alertQueue.list(after) };
  });

  // Notification-click reveal. focus defaults false here (raise without
  // stealing keyboard focus) — the opposite of the dashboard's explicit
  // reveal button; `notifications.clickFocus` flips it.
  app.post<{ Body: { iterm_session_id?: string; focus?: boolean } }>(
    '/api/reveal',
    async (req) => {
      const guid = req.body?.iterm_session_id;
      if (!guid) return { ok: false, found: false };
      const focus = req.body?.focus ?? prefs.get().notifications.clickFocus;
      const found = await tracker.revealIterm(guid, { focus });
      return { ok: true, found };
    },
  );

  // Menubar master toggle. Writes through the same PrefsStore the
  // dashboard modal uses, so the two switches never disagree.
  app.post<{ Body: { enabled?: boolean } }>('/api/notifications', async (req) => {
    const enabled = req.body?.enabled === true;
    await prefs.update({ notifications: { ...prefs.get().notifications, muteAll: !enabled } });
    return { enabled };
  });
```

(`prefs`, `monitor`, `tracker` are all in scope at the `/api/summary` site. If `prefs.get()` doesn't exist, the tRPC router at `server/src/trpc.ts:211` shows the accessor name — use whatever `ctx.prefs.get()` resolves to.)

- [ ] **Step 2: Typecheck** — `npm run build:server` — Expected: clean

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(alerts): /api/alerts, /api/reveal, /api/notifications routes for the menubar helper"
```

### Task 6: Client — muteAll + prefs UI

**Files:** Modify `client/src/lib/useAwaitingNotifications.ts`, `client/src/components/PrefsModal.tsx`

- [ ] **Step 1: Honor muteAll in the client channels**

`useAwaitingNotifications.ts`: add `muteAll: boolean;` to `NotificationPrefs`; at the top of both effects (the transition effect and the tab-title effect), guard `if (prefs.muteAll) return;` — for the title effect, restore `document.title` to base before returning, matching its existing cleanup path. (The caller already passes the whole `prefs.notifications` object, which now carries `muteAll`.)

- [ ] **Step 2: Extend the PrefsModal Notifications section** (after the audible-chime field, `PrefsModal.tsx` ~line 668)

```tsx
      <CheckboxField
        label="Mute all notifications"
        hint="Master switch — silences every channel above and below, including the menu bar helper's macOS notifications. Mirrors the toggle in the menu bar menu."
        checked={draft.notifications.muteAll}
        onChange={(v) => set({ muteAll: v })}
      />
      <CheckboxField
        label="macOS notifications (menu bar helper)"
        hint="Native Notification Center banner when a session has been waiting for input past the grace period. Delivered by the brainhouse menu bar helper; click raises the session's iTerm window."
        checked={draft.notifications.macNative}
        onChange={(v) => set({ macNative: v })}
      />
      <CheckboxField
        label="Also notify when a turn completes"
        hint="Immediate banner on each Stop — 'session finished, ready for your next prompt'. Noisier; off by default."
        checked={draft.notifications.macNativeTurnComplete}
        onChange={(v) => set({ macNativeTurnComplete: v })}
      />
      <NumberField
        label="Grace period (seconds)"
        hint="Only notify if the session is still waiting after this long. Prompts you answer immediately never notify. 0 = notify instantly."
        value={draft.notifications.graceSeconds}
        min={0}
        onChange={(v) => set({ graceSeconds: v })}
      />
      <CheckboxField
        label="Clicking a notification focuses iTerm"
        hint="Default off: the iTerm window is raised to the front of the window stack but keyboard focus stays where you are."
        checked={draft.notifications.clickFocus}
        onChange={(v) => set({ clickFocus: v })}
      />
```

- [ ] **Step 3: Run client tests + typecheck**

Run: `npm run test:client && npm run build:client`
Expected: PASS / clean

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/useAwaitingNotifications.ts client/src/components/PrefsModal.tsx
git commit -m "feat(prefs-ui): native-notification prefs + muteAll honored by client channels"
```

### Task 7: Menubar helper — bundle, notifications, click, toggle

**Files:** Modify `menubar/main.swift`, `scripts/install-menubar.sh`

- [ ] **Step 1: install-menubar.sh — package as .app bundle**

Replace the `BIN=` definition and compile step with:

```bash
APP_BUNDLE="$APP_DIR/BrainhouseMenuBar.app"
BIN="$APP_BUNDLE/Contents/MacOS/BrainhouseMenuBar"

mkdir -p "$APP_BUNDLE/Contents/MacOS" "$HOME/Library/LaunchAgents"
swiftc -O -o "$BIN" menubar/main.swift

# UNUserNotificationCenter refuses to run without a real bundle identity —
# a bare binary crashes on first use. LSUIElement keeps it out of the Dock.
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.brainhouse.menubar</string>
  <key>CFBundleName</key><string>brainhouse</string>
  <key>CFBundleExecutable</key><string>BrainhouseMenuBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Migrate away from the old bare-binary install.
rm -f "$APP_DIR/BrainhouseMenuBar"
```

The launchd plist's `ProgramArguments` already interpolates `$BIN`, which now points inside the bundle — no other plist change.

- [ ] **Step 2: main.swift — notifications + click + toggle**

Top of file: `import UserNotifications`. New state on `AppDelegate`:

```swift
    private var alertCursor: Int = -1
    private var alertCursorSeeded = false
    private var notificationsEnabled = true
    private var notificationsAuthDenied = false
```

In `applicationDidFinishLaunching`, before the timer setup:

```swift
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            DispatchQueue.main.async { self?.notificationsAuthDenied = !granted }
        }
```

New poll leg — call `fetchAlerts()` at the end of `fetchSummary()`'s completion (so it only runs when the server answers):

```swift
    private func fetchAlerts() {
        var request = URLRequest(url: URL(string: "http://localhost:\(port)/api/alerts?after=\(alertCursor)")!)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.notificationsEnabled = obj["enabled"] as? Bool ?? true
                let alerts = obj["alerts"] as? [[String: Any]] ?? []
                let maxId = alerts.compactMap { $0["id"] as? Int }.max() ?? self.alertCursor
                // First poll after launch seeds the cursor silently, so a
                // helper restart never replays banners the server still holds.
                if !self.alertCursorSeeded {
                    self.alertCursorSeeded = true
                    self.alertCursor = maxId
                    return
                }
                for alert in alerts { self.post(alert: alert) }
                self.alertCursor = max(self.alertCursor, maxId)
            }
        }.resume()
    }

    private func post(alert: [String: Any]) {
        let content = UNMutableNotificationContent()
        content.title = alert["title"] as? String ?? "brainhouse session"
        if let project = alert["project"] as? String { content.subtitle = project }
        let reason = alert["reason"] as? String ?? "awaiting"
        content.body = reason == "turn_complete" ? "Turn finished — ready for your next prompt"
                                                 : "Waiting for your input"
        content.sound = .default
        if let guid = alert["iterm_session_id"] as? String { content.userInfo = ["guid": guid] }
        let id = "brainhouse-alert-\(alert["id"] as? Int ?? 0)"
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
```

Click handler — new extension:

```swift
extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard let guid = response.notification.request.content.userInfo["guid"] as? String else { return }
        var request = URLRequest(url: URL(string: "http://localhost:\(port)/api/reveal")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["iterm_session_id": guid])
        URLSession.shared.dataTask(with: request).resume()
    }

    // Post banners even while the helper is "frontmost" (accessory apps
    // count as foreground for their own notifications).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
```

(`/api/reveal` applies the `clickFocus` pref server-side when the body omits `focus` — the helper stays pref-ignorant.)

Menu toggle — in `menuNeedsUpdate`, after the Open Dashboard item:

```swift
        let notifItem = makeItem("Notifications", #selector(toggleNotifications))
        notifItem.state = notificationsEnabled ? .on : .off
        menu.addItem(notifItem)
        if notificationsAuthDenied {
            menu.addItem(infoItem("Notifications blocked in System Settings"))
        }
```

Action:

```swift
    @objc private func toggleNotifications() {
        var request = URLRequest(url: URL(string: "http://localhost:\(port)/api/notifications")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": !notificationsEnabled])
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.poll() }
        }.resume()
    }
```

- [ ] **Step 3: Compile check**

Run: `swiftc -O -o /tmp/bh-menubar-check menubar/main.swift && rm /tmp/bh-menubar-check`
Expected: compiles clean (UserNotifications links fine outside a bundle; it only *runs* bundled)

- [ ] **Step 4: Commit**

```bash
git add menubar/main.swift scripts/install-menubar.sh
git commit -m "feat(menubar): native notifications with click-to-reveal + master toggle; .app bundle packaging"
```

### Task 8: Ship + end-to-end smoke + docs

- [ ] **Step 1: Build + restart server**

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.brainhouse
```

- [ ] **Step 2: Reinstall menubar helper**

```bash
npm run menubar:install
```

Expected: helper reappears in the menu bar; macOS prompts for notification permission — the user must accept (surface this in the final report if the session is unattended).

- [ ] **Step 3: Smoke the routes**

```bash
curl -s 'http://localhost:8765/api/alerts?after=-1'
# → {"enabled":true,"alerts":[...]}
curl -s -X POST http://localhost:8765/api/notifications -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -s 'http://localhost:8765/api/alerts?after=-1' | grep '"enabled":false'
curl -s -X POST http://localhost:8765/api/notifications -H 'Content-Type: application/json' -d '{"enabled":true}'
```

- [ ] **Step 4: Live smoke** — trigger a real permission prompt in a throwaway Claude Code session, wait ≥30s without answering, confirm the banner arrives; click it and confirm the iTerm window raises without stealing focus. (Requires the Accessibility grant for node the first time — System Settings → Privacy & Security → Accessibility.)

- [ ] **Step 5: docs/assertions.md** — append:

```markdown
- **A session waiting past the grace window posts a macOS notification.**
  The server-side `AlertQueue` (`server/src/alertQueue.ts`) owns every
  decision: `notification` hook → grace timer (`notifications.graceSeconds`,
  default 30s; waits answered inside the window never alert), optional
  immediate `turn_complete` alerts on Stop (`macNativeTurnComplete`, off
  by default), one alert per wait-episode, 10-minute expiry, and
  read-time revalidation (an alert for a no-longer-awaiting panel is
  never delivered). The menu bar helper is a dumb delivery arm: it polls
  `GET /api/alerts?after=<cursor>` on its existing 5s cadence, seeds the
  cursor silently on its first poll (helper restarts never replay), and
  posts via `UNUserNotificationCenter` (which requires the helper's new
  `.app` bundle identity). `notifications.muteAll` gates every channel —
  server queue and client channels alike — and is flippable from both the
  prefs modal and the helper's menu toggle (`POST /api/notifications`),
  which share the prefs file and therefore never disagree.
- **Notification clicks raise the iTerm window without stealing focus.**
  Click → `POST /api/reveal` → `revealItermSession(guid, {focus:false})`:
  the same window/tab/pane `select` walk as the focusing variant, then a
  System Events `AXRaise` instead of `activate` — the window tops the
  global z-order while keyboard focus stays put. `notifications.clickFocus`
  restores the focusing behavior for clicks; the dashboard's reveal
  button always focuses. Requires an Accessibility grant for the server
  process; when missing, the pane is still selected inside iTerm and the
  call resolves `found:false`-style graceful.
```

- [ ] **Step 6: Commit**

```bash
git add docs/assertions.md
git commit -m "docs(assertions): awaiting-input alert + no-focus reveal rules"
```

## Self-review notes

- Spec coverage: AlertQueue (T2), prefs (T1, T6), routes incl. menubar toggle (T5), no-focus reveal (T4), bundle+Swift (T7), permissions/smoke/docs (T8). Stretch items (color chips, web fallback) intentionally absent.
- Type consistency: `getNotificationPrefs` name shared by AlertQueue options and monitor options; `revealIterm(guid, {focus})` shape consistent across native/index/trpc/route.
