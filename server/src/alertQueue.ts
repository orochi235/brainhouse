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
  /** Test seams — default to wall clock / setTimeout. */
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
      this.cancelTimer(panelId);
      this.alerts = this.alerts.filter(
        (a) => !(a.panel_id === panelId && a.reason === 'awaiting'),
      );
      return;
    }
    const prefs = this.opts.getNotificationPrefs();
    if (prefs.muteAll || !prefs.macNative) return;
    // One alert per wait episode: a pending timer or an already-queued
    // alert for this panel means this transition is a duplicate.
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
    this.cancelTimer(panelId);
    this.alerts = this.alerts.filter((a) => a.panel_id !== panelId);
  }

  private cancelTimer(panelId: string): void {
    const t = this.pendingTimers.get(panelId);
    if (t !== undefined) {
      this.clearTimer(t);
      this.pendingTimers.delete(panelId);
    }
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
