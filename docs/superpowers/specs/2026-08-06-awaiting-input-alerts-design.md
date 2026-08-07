# Awaiting-input alerts: macOS notifications with no-focus reveal

**Date:** 2026-08-06
**Status:** Approved

## Problem

Sessions block on input (permission prompts, AskUserQuestion, idle
warnings) and the user doesn't notice — the only signals are the panel's
awaiting badge in the dashboard and the menu bar count, both of which
require looking. Real time is lost to sessions silently waiting.

## Goal

Post a macOS notification when a session has been waiting for input past
a grace window. Clicking the notification raises the session's iTerm2
window/pane to the top of the window stack **without stealing keyboard
focus**.

## Non-goals (v1)

- Per-project color-chip attachment images on notifications (stretch).
- Web Notifications fallback for when the helper isn't running (stretch).
- Any terminal besides iTerm2 (see the `[HIGH]` terminal-adapter TODO;
  this feature should route through that abstraction when it lands, but
  does not wait for it).

## Architecture

The **server owns all alerting decisions** (prefs, grace timing, dedupe,
cancellation, expiry). The **menubar helper is a dumb delivery arm**: it
polls, posts what it's given, and reports clicks. Prefs never leave the
server.

### Server: `AlertQueue` (new module, `server/src/alertQueue.ts`)

Watches panel transitions the monitor already routes:

- `awaiting_input → true`: start a per-panel grace timer
  (`notifications.graceSeconds`, default 30; `0` = immediate). If the
  panel is still awaiting when the timer fires, enqueue an alert. If the
  wait clears first, cancel silently — prompts answered while the user
  is present never notify.
- Stop hook (`turn_complete` trigger, **off by default**): enqueue
  immediately, no grace.
- Alert shape: `{ id (monotonic), panel_id, title, project, account,
  iterm_session_id, reason: 'awaiting' | 'turn_complete', ts }`.
- Lifecycle: an alert is removed when (a) delivered-and-clicked isn't
  tracked — delivery is fire-and-forget; (b) the wait clears; (c) it
  ages past ~10 minutes. One alert per panel per wait-episode; a
  re-entered wait re-alerts.

### HTTP surface (plain routes in `server/src/index.ts`, next to `/api/summary`)

- `GET /api/alerts?after=<id>` → `{ enabled: boolean, alerts: Alert[] }`,
  cursor-paginated by monotonic id. Cheap to poll; returns `[]` when
  nothing new. `enabled` mirrors `notifications.enabled` so the helper's
  menu toggle renders current state.
- `POST /api/reveal` body `{ iterm_session_id, focus?: boolean }` →
  existing `tracker.revealIterm`, extended with the no-focus variant.
- `POST /api/notifications` body `{ enabled: boolean }` → flips the
  `notifications.enabled` pref. Backing store is the same prefs file the
  dashboard modal edits, so the two toggles never disagree.

### Reveal without focus (`server/src/processes/native.ts`)

`revealItermSession(guid, { focus })`:

- `focus: true` (existing behavior): select session/tab/window +
  `activate`.
- `focus: false` (new, default for notification clicks): same select
  walk, **no `activate`**; then System Events
  `perform action "AXRaise" of window 1 of process "iTerm2"` raises the
  window to the top of the global z-order while the frontmost app keeps
  keyboard focus.
- Pref `notifications.clickFocus` (default `false`) flips clicks to the
  focusing variant. The dashboard's reveal button keeps `focus: true`
  (explicit "take me there").

### Menubar helper (`menubar/main.swift` + `scripts/install-menubar.sh`)

- `install-menubar.sh` packages the compiled binary as a minimal
  `brainhouse-menubar.app` bundle (`Contents/MacOS/` + `Info.plist` with
  `CFBundleIdentifier com.brainhouse.menubar`) —
  `UNUserNotificationCenter` requires a real bundle identity.
- On launch: request notification authorization.
- The existing 5s poll additionally fetches `GET /api/alerts?after=<cursor>`.
  The cursor lives in helper memory. On the first poll after helper
  launch, the response seeds the cursor and nothing is posted — so a
  helper restart never replays banners for alerts the server still
  holds.
- Each new alert posts a notification: title = panel title, subtitle =
  project, body = reason ("waiting for input" / "turn finished").
  `userInfo` carries the guid; the notification-response delegate calls
  `POST /api/reveal {guid, focus: false}`.
- Menu gains a "Notifications" toggle item (checkmark reflects the
  `enabled` flag from the last `/api/alerts` poll; selecting it POSTs
  `/api/notifications` with the flipped value). Disabling silences all
  brainhouse notifications at the source — the AlertQueue stops
  enqueuing — not just this helper's delivery.
- Menu shows a hint line when notification authorization is denied.

### Prefs (dashboard prefs modal, new Notifications section)

| Pref | Default |
| --- | --- |
| `notifications.enabled` | `true` |
| `notifications.triggers.blocked` | `true` |
| `notifications.triggers.turnComplete` | `false` |
| `notifications.graceSeconds` | `30` |
| `notifications.clickFocus` | `false` |

## Permissions (one-time)

- Helper: notification authorization (prompted on first launch).
- Server (node, the LaunchAgent): Automation→iTerm2 (already granted by
  the existing reveal path) + Accessibility for the System Events
  `AXRaise` call. Reveal degrades gracefully to select-without-raise
  when the grant is missing (osascript errors are already swallowed to
  `false`).

## Error handling

- Helper down: alerts expire server-side; no replay flood on reconnect.
- Server down: helper already renders the stopped state; no alerts.
- osascript failure / GUID not found: `POST /api/reveal` returns
  `{found: false}`; helper does nothing further (the notification
  already served its awareness purpose).

## Testing

- `AlertQueue`: pure-logic tests over fake timers (grace fire,
  cancel-on-clear, immediate mode, turn_complete trigger, expiry,
  cursor pagination, re-alert on re-entered wait) — same fake-timer
  style as `titler.test.ts`.
- Reveal: unit-test the AppleScript selection (focus vs no-focus script
  text); manual smoke for the AX behavior.
- Helper: manual smoke (notification arrives, click raises without
  focus).
