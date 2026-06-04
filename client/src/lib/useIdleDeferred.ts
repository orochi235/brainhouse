import { useEffect, useRef, useState } from 'react';

/** True while the user has interacted with the page in the last
 * `idleMs` milliseconds. Switches to false after a period of stillness.
 * Listens for mousemove, mousedown, keydown, wheel, scroll on the
 * document (capture phase, passive). 0 disables the tracking entirely
 * and returns false. */
export function useUserActive(idleMs: number): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (idleMs <= 0) {
      setActive(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onActivity = () => {
      setActive(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setActive(false), idleMs);
    };
    const onBlur = () => {
      // Tabbed away — let layout reflow.
      if (timer) clearTimeout(timer);
      setActive(false);
    };
    const events: Array<keyof DocumentEventMap> = [
      'mousemove', 'mousedown', 'keydown', 'wheel', 'scroll',
    ];
    for (const ev of events) {
      document.addEventListener(ev, onActivity, { capture: true, passive: true });
    }
    window.addEventListener('blur', onBlur);
    return () => {
      if (timer) clearTimeout(timer);
      for (const ev of events) {
        document.removeEventListener(ev, onActivity, { capture: true });
      }
      window.removeEventListener('blur', onBlur);
    };
  }, [idleMs]);
  return active;
}

/** Returns the most recent `value` captured while the user was idle.
 * While `isActive` is true, the returned value is frozen at whatever
 * was last seen during idle — so consumers can re-render their own
 * content without the gated value changing under them. When the user
 * goes idle again, the next render picks up the live `value`. */
export function useIdleDeferred<T>(value: T, isActive: boolean): T {
  const [held, setHeld] = useState<T>(value);
  const last = useRef<T>(value);
  last.current = value;
  useEffect(() => {
    if (!isActive) setHeld(last.current);
  }, [isActive, value]);
  return isActive ? held : value;
}
