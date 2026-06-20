/** Time-formatting helpers shared by panel header + thinking timer. */

export function formatIdle(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  // Lead with the largest non-zero unit ("1d 13h 3m" rather than
  // "37h 3m"). When a smaller unit follows the lead, keep all units
  // between them even if intermediate ones are zero — "1d 0h 3m"
  // reads more honestly than "1d 3m". Trailing zero units are still
  // dropped (e.g. "1d" alone, "1d 13h").
  if (days > 0) {
    if (!hours && !minutes) return `${days}d`;
    return minutes ? `${days}d ${hours}h ${minutes}m` : `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/** The two most significant *nonzero* units of a duration, largest first,
 * skipping any zero units in between (`1w 0d 3h 3m → "1w 3h"`,
 * `1w 1d 3h 3m → "1w 1d"`). Goes up to weeks. Sub-minute durations render as
 * bare seconds; a duration with a single nonzero unit renders just that unit
 * (`3600 → "1h"`). Used by the top widget's time columns (idle, uptime). */
export function formatDurationTwoUnits(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const units: Array<[string, number]> = [
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts: string[] = [];
  let rem = total;
  for (const [label, size] of units) {
    const v = Math.floor(rem / size);
    if (v > 0) {
      parts.push(`${v}${label}`);
      rem -= v * size;
    }
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(' ') : '0s';
}

/** Like formatIdle, but capped at the two most significant units —
 * "1d 13h" rather than "1d 13h 3m". Trailing zero units are dropped, so a
 * duration just over a boundary collapses to one unit ("1d", "1h"). Used
 * for the processes Uptime column, where coarse-but-glanceable beats
 * exact. */
export function formatDurationShort(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/** Coarse: only the largest unit. For closed/archived sessions. */
export function formatIdleCoarse(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Render a token count as a short string: 845 → "845", 1500 → "1.5k",
 * 1_500_000 → "1.5m". Used in the panel-header tokens capsule. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}m`;
}

// Reuse a single formatter: constructing `Intl.DateTimeFormat` (which
// `toLocaleTimeString` does internally on each call) is expensive, and
// this runs hundreds of times per render across the timeline/event maps.
const CLOCK_FORMAT = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatClockTime(ts: string): string {
  let d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) d = new Date();
  return CLOCK_FORMAT.format(d);
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `+${Math.floor(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return s ? `+${m}m${s}s` : `+${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `+${h}h${m}m` : `+${h}h`;
}
