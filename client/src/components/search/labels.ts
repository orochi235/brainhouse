import type { Doc } from '@server/search/extract.ts';

/** The short role label shown beside a hit and a reader row: who said it, or
 * which tool ran. Matches the `role:` filter's vocabulary. */
export function roleLabel(kind: Doc['kind'], tool: string | null, isError: boolean): string {
  switch (kind) {
    case 'user_text':
      return 'you';
    case 'assistant_text':
      return 'ai';
    case 'thinking':
      return 'thinking';
    case 'tool_use':
      return tool ?? 'tool';
    case 'tool_result':
      return isError ? 'error' : 'out';
  }
}

const SAME_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const OTHER_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Unix seconds → "14:02" today, "Oct 4" this year, "Oct 4, 2025" before. */
export function formatWhen(ts: number, now: Date = new Date()): string {
  const d = new Date(ts * 1000);
  if (d.toDateString() === now.toDateString()) return CLOCK.format(d);
  return d.getFullYear() === now.getFullYear() ? SAME_YEAR.format(d) : OTHER_YEAR.format(d);
}

export function formatClock(ts: number): string {
  return CLOCK.format(new Date(ts * 1000));
}
