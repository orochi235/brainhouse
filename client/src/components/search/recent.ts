const KEY = 'brainhouse.search.recent';
const MAX = 12;

export function recentQueries(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Move `q` to the front, keeping the newest dozen. */
export function rememberQuery(q: string): void {
  const t = q.trim();
  if (!t) return;
  try {
    const next = [t, ...recentQueries().filter((x) => x !== t)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: recent queries are a convenience.
  }
}
