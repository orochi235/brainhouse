/**
 * Active nudges when a panel flips to `awaiting_input` (false → true).
 *
 * The UI's passive surface (status dot, awaiting badge) is invisible when
 * brainhouse is in a background tab or another monitor. This hook layers
 * three channels on top, each independently togglable in prefs:
 *
 *   - Tab-title flash: while any panel is awaiting AND the tab is hidden,
 *     prepend "● " to `document.title`. Reverts as soon as either side
 *     clears. Steady-state; no permission cost.
 *
 *   - Browser Notification: native OS toast on each transition. Click →
 *     focus the brainhouse tab + scroll to the panel. Requires
 *     `Notification.permission === 'granted'`; the PrefsModal triggers
 *     `requestPermission()` when the user flips the pref on.
 *
 *   - Audible chime: a short WebAudio beep on each transition. No asset.
 *
 * Transitions, not polling. We track prior `awaiting_input` per panel id
 * in a ref so a panel that's been stuck awaiting for ten minutes doesn't
 * keep firing every render.
 */

import { useEffect, useRef } from 'react';
import type { PanelState } from '../useDeltaStream.ts';

interface NotificationPrefs {
  tabTitleFlash: boolean;
  browserNotification: boolean;
  audibleChime: boolean;
}

const TITLE_FLASH_PREFIX = '● ';

export function useAwaitingNotifications(
  panels: Map<string, PanelState>,
  prefs: NotificationPrefs,
): void {
  // Track previous awaiting state per panel so we fire only on false→true.
  const prevAwaiting = useRef<Map<string, boolean>>(new Map());
  // Cache the original title so we can restore it cleanly.
  const baseTitle = useRef<string>(document.title);

  // Channel: per-transition toast + chime.
  useEffect(() => {
    const transitions: PanelState[] = [];
    const seen = new Set<string>();
    for (const p of panels.values()) {
      seen.add(p.id);
      const was = prevAwaiting.current.get(p.id) ?? false;
      if (!was && p.awaiting_input) transitions.push(p);
      prevAwaiting.current.set(p.id, p.awaiting_input);
    }
    // Drop entries for panels that have been removed entirely.
    for (const id of Array.from(prevAwaiting.current.keys())) {
      if (!seen.has(id)) prevAwaiting.current.delete(id);
    }

    if (transitions.length === 0) return;
    if (prefs.browserNotification) {
      for (const p of transitions) fireBrowserNotification(p);
    }
    if (prefs.audibleChime) playChime();
  }, [panels, prefs.browserNotification, prefs.audibleChime]);

  // Channel: tab-title flash. Driven by current state + tab visibility.
  useEffect(() => {
    if (!prefs.tabTitleFlash) return;

    const update = () => {
      let anyAwaiting = false;
      for (const p of panels.values()) {
        if (p.awaiting_input) {
          anyAwaiting = true;
          break;
        }
      }
      const stripped = document.title.startsWith(TITLE_FLASH_PREFIX)
        ? document.title.slice(TITLE_FLASH_PREFIX.length)
        : document.title;
      // Remember the steady-state title so cleanup can restore it even if
      // some other code mutated it while we were prefixed.
      baseTitle.current = stripped;
      const shouldFlash = anyAwaiting && document.hidden;
      document.title = shouldFlash ? `${TITLE_FLASH_PREFIX}${stripped}` : stripped;
    };

    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      // Restore on unmount or pref-off so we never leave a stale "● ".
      if (document.title.startsWith(TITLE_FLASH_PREFIX)) {
        document.title = document.title.slice(TITLE_FLASH_PREFIX.length);
      }
    };
  }, [panels, prefs.tabTitleFlash]);
}

function fireBrowserNotification(panel: PanelState): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  const title = panel.title || panel.id.slice(0, 8);
  const body = panel.task_description
    ? `${panel.task_description} — awaiting input`
    : 'Awaiting your input';
  // `tag` collapses repeat toasts for the same panel into one OS slot.
  const n = new Notification(`brainhouse · ${title}`, { body, tag: panel.id });
  n.onclick = () => {
    window.focus();
    const el = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panel.id)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('focus-pulse');
      window.setTimeout(() => el.classList.remove('focus-pulse'), 900);
    }
    n.close();
  };
}

// Module-level so repeated calls within a tick share one AudioContext; some
// browsers cap the per-page total.
let audioCtx: AudioContext | null = null;

function playChime(): void {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // Two-tone ping: a brief 880 → 1320 chirp. Pleasant, distinct from
    // OS chrome, and short enough to not be obnoxious on rapid transitions.
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.linearRampToValueAtTime(1320, now + 0.12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.32);
  } catch {
    // Audio blocked (autoplay policy, no user gesture yet) — silent fail.
  }
}
