import type { ObservedDb, ObservedEntry, ScanResult } from './types.mts';
import { maxVersion, minVersion } from './version.mts';

const UNKNOWN = 'unknown';

/** A stored version that is the `'unknown'` sentinel is "absent" for
 * comparison — otherwise `compareVersions` parses it as 0.0.0 and it
 * permanently wins `minVersion`, freezing `firstSeenVersion`. */
function real(v: string | undefined): string | null {
  return v && v !== UNKNOWN ? v : null;
}

/**
 * Fold a scan result into the cumulative sidecar. Version bounds widen
 * forever (survive log pruning); lastWindowCount is replaced with this
 * run's count (0 when unseen). Iterates `result.perSelector`, which holds
 * one entry per registry selector — so the output stays 1:1 with the
 * registry. The `'unknown'` sentinel is only a display value; it never
 * participates in min/max comparison.
 */
export function mergeObserved(existing: ObservedDb, result: ScanResult, scanAt: string): ObservedDb {
  const out: ObservedDb = {};
  for (const [key, tally] of Object.entries(result.perSelector)) {
    const prev = existing[key];
    const entry: ObservedEntry = {
      firstSeenVersion: minVersion(real(prev?.firstSeenVersion), tally.minVersion) ?? UNKNOWN,
      lastSeenVersion: maxVersion(real(prev?.lastSeenVersion), tally.maxVersion) ?? UNKNOWN,
      lastWindowCount: tally.count,
      lastScanAt: scanAt,
    };
    out[key] = entry;
  }
  return out;
}
