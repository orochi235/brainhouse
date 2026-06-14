import { useClock } from '../lib/clock.ts';

/**
 * Browser-session uptime — seconds since this renderer loaded the page
 * (`performance.timeOrigin`). A debug-only topbar readout for correlating
 * the renderer's slow memory creep with how long the tab has been alive.
 *
 * Leaf component: it subscribes to the shared 1Hz clock so only this span
 * re-renders each tick — not the topbar or App. (Re-rendering the whole
 * tree once a second is itself part of what grows the renderer heap, so a
 * memory-diagnostic clock must not do it.)
 */
export function UptimeClock() {
  const nowSec = useClock();
  const uptimeSec = Math.max(0, nowSec - performance.timeOrigin / 1000);
  return (
    <span
      className="topbar-uptime"
      title="Browser session uptime — time since this tab loaded the page"
    >
      up {formatUptime(uptimeSec)}
    </span>
  );
}

function formatUptime(totalSec: number): string {
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(sec)}`;
}
