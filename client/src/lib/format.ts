/** Time-formatting helpers shared by panel header + thinking timer. */

export function formatIdle(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Coarse: only the largest unit. For closed/archived sessions. */
export function formatIdleCoarse(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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
