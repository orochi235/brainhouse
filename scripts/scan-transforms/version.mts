/** Segment-wise numeric comparison of dotted version strings ("2.1.112"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function maxVersion(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

export function minVersion(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return compareVersions(a, b) <= 0 ? a : b;
}
