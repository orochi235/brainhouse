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

export function formatClockTime(ts: string): string {
  let d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toLocaleTimeString([], { hour12: false });
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
